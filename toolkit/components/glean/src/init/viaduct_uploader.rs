// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use glean::net::{CapablePingUploadRequest, PingUploadRequest, PingUploader, UploadResult};
#[cfg(not(feature = "felt"))]
use once_cell::sync::OnceCell;
#[cfg(not(feature = "felt"))]
use std::sync::Once;
use url::Url;
use viaduct::{Request, ViaductError::*};

extern "C" {
    fn FOG_TooLateToSend() -> bool;
}

/// An uploader that uses [Viaduct](https://github.com/mozilla/application-services/tree/main/components/viaduct).
#[derive(Debug)]
pub(crate) struct ViaductUploader;

impl PingUploader for ViaductUploader {
    /// Uploads a ping to a server.
    ///
    /// # Arguments
    ///
    /// * `upload_request` - the ping and its metadata to upload.
    fn upload(&self, upload_request: CapablePingUploadRequest) -> UploadResult {
        let mut requires_ohttp = false;
        let upload_request = match upload_request.capable(|capabilities| {
            requires_ohttp = capabilities == ["ohttp"];
            capabilities.is_empty() || requires_ohttp
        }) {
            Some(req) => req,
            None => return UploadResult::incapable(),
        };
        log::trace!("FOG Ping Uploader uploading to {}", upload_request.url);

        // SAFETY NOTE: Safe because it returns a primitive by value.
        if unsafe { FOG_TooLateToSend() } {
            log::trace!("Attempted to send ping too late into shutdown.");
            return UploadResult::done();
        }

        let debug_tagged = upload_request
            .headers
            .iter()
            .any(|(name, _)| name == "X-Debug-ID");
        let localhost_port = static_prefs::pref!("telemetry.fog.test.localhost_port");
        if localhost_port < 0
            || (localhost_port == 0 && !debug_tagged && cfg!(feature = "disable_upload"))
        {
            log::info!("FOG Ping uploader faking success");
            return UploadResult::http_status(200);
        }

        #[cfg(feature = "felt")]
        let result = modify_for_enterprise(upload_request)
            .and_then(|upload_request| viaduct_upload(upload_request));

        // Localhost-destined pings are sent without OHTTP,
        // even if configured to use OHTTP.
        #[cfg(not(feature = "felt"))]
        let result =
            if localhost_port == 0 && requires_ohttp && should_ohttp_upload(&upload_request) {
                ohttp_upload(upload_request)
            } else {
                viaduct_upload(upload_request)
            };

        log::trace!(
            "FOG Ping Uploader completed uploading (Result {:?})",
            result
        );

        match result {
            Ok(result) => result,
            Err(ViaductUploaderError::Viaduct(ve)) => match ve {
                NonTlsUrl
                | UrlError(_)
                | BackendAlreadyInitialized
                | OhttpNotSupported
                | OhttpChannelNotConfigured(_) => UploadResult::unrecoverable_failure(),
                RequestHeaderError(_)
                | BackendError(_)
                | NetworkError(_)
                | BackendNotInitialized
                | SetBackendError
                | OhttpConfigFetchFailed(_)
                | OhttpRequestError(_)
                | OhttpResponseError(_) => UploadResult::recoverable_failure(),
            },
            Err(ViaductUploaderError::Bhttp(_) | ViaductUploaderError::Ohttp(_)) => {
                UploadResult::unrecoverable_failure()
            }
            #[cfg(feature = "felt")]
            Err(
                ViaductUploaderError::EnterpriseErrorAccessToken
                | ViaductUploaderError::EnterpriseNoAccessToken
                | ViaductUploaderError::EnterpriseUrlNotSet,
            ) => UploadResult::recoverable_failure(),
            #[cfg(feature = "felt")]
            Err(ViaductUploaderError::EnterpriseInvalidUrl(_)) => {
                UploadResult::unrecoverable_failure()
            }
            #[cfg(not(feature = "felt"))]
            Err(ViaductUploaderError::Fatal) => UploadResult::unrecoverable_failure(),
        }
    }
}

fn viaduct_upload(upload_request: PingUploadRequest) -> Result<UploadResult, ViaductUploaderError> {
    let parsed_url = Url::parse(&upload_request.url)?;

    log::info!("FOG viaduct uploader uploading to {:?}", parsed_url);

    let mut req = Request::post(parsed_url.clone()).body(upload_request.body);
    for (header_key, header_value) in &upload_request.headers {
        req = req.header(header_key.to_owned(), header_value)?;
    }

    log::trace!("FOG viaduct uploader sending ping to {:?}", parsed_url);
    let res = req.send()?;
    Ok(UploadResult::http_status(res.status as i32))
}

#[cfg(feature = "felt")]
fn modify_for_enterprise(
    mut upload_request: PingUploadRequest,
) -> Result<PingUploadRequest, ViaductUploaderError> {
    let console_url = felt::CONSOLE_URL
        .get()
        .ok_or(ViaductUploaderError::EnterpriseUrlNotSet)?;
    let mut parsed_console_url =
        Url::parse(console_url).map_err(ViaductUploaderError::EnterpriseInvalidUrl)?;

    let parsed_url = Url::parse(&upload_request.url)?;
    parsed_console_url.set_path(&format!(
        "{}/api/browser/telemetry/{}",
        parsed_console_url
            .path()
            .strip_prefix('/')
            .unwrap_or(parsed_console_url.path()),
        parsed_url
            .path()
            .strip_prefix('/')
            .unwrap_or(parsed_url.path())
    ));
    parsed_console_url.set_query(parsed_url.query());
    parsed_console_url.set_fragment(parsed_url.fragment());

    let bearer = {
        let t = felt::TOKENS
            .read()
            .map_err(|_| ViaductUploaderError::EnterpriseErrorAccessToken)?;
        if !t.access_token.is_empty() {
            format!("Bearer {}", &t.access_token)
        } else {
            return Err(ViaductUploaderError::EnterpriseNoAccessToken);
        }
    };

    upload_request.url = parsed_console_url.to_string();
    upload_request
        .headers
        .push(("Authorization".to_string(), bearer));
    Ok(upload_request)
}

#[cfg(not(feature = "felt"))]
fn should_ohttp_upload(upload_request: &PingUploadRequest) -> bool {
    !upload_request.body_has_info_sections
}

#[cfg(not(feature = "felt"))]
fn ohttp_upload(upload_request: PingUploadRequest) -> Result<UploadResult, ViaductUploaderError> {
    static CELL: OnceCell<Vec<u8>> = once_cell::sync::OnceCell::new();
    let config = CELL.get_or_try_init(get_config)?;

    let binary_request = bhttp_encode(upload_request)?;

    static OHTTP_INIT: Once = Once::new();
    OHTTP_INIT.call_once(|| {
        ohttp::init();
    });

    let ohttp_request = ohttp::ClientRequest::from_encoded_config(config)?;
    let (capsule, ohttp_response) = ohttp_request.encapsulate(&binary_request)?;

    const OHTTP_RELAY_URL: &str = "https://mozilla-ohttp.fastly-edge.com/";
    let parsed_relay_url = Url::parse(OHTTP_RELAY_URL)?;

    log::trace!("FOG ohttp uploader uploading to {}", parsed_relay_url);

    const OHTTP_MESSAGE_CONTENT_TYPE: &str = "message/ohttp-req";
    let req = Request::post(parsed_relay_url)
        .header(
            viaduct::header_names::CONTENT_TYPE,
            OHTTP_MESSAGE_CONTENT_TYPE,
        )?
        .body(capsule);
    let res = req.send()?;

    if res.status == 200 {
        // This just tells us the HTTP went well. Check OHTTP's status.
        let binary_response = ohttp_response.decapsulate(&res.body)?;
        let mut cursor = std::io::Cursor::new(binary_response);
        let bhttp_message = bhttp::Message::read_bhttp(&mut cursor)?;
        let res = bhttp_message
            .control()
            .status()
            .ok_or(ViaductUploaderError::Fatal)?;
        Ok(UploadResult::http_status(res.code() as i32))
    } else {
        Ok(UploadResult::http_status(res.status as i32))
    }
}

#[cfg(not(feature = "felt"))]
fn get_config() -> Result<Vec<u8>, ViaductUploaderError> {
    const OHTTP_CONFIG_URL: &str =
        "https://prod.ohttp-gateway.prod.webservices.mozgcp.net/ohttp-configs";
    log::trace!("Getting OHTTP config from {}", OHTTP_CONFIG_URL);
    let parsed_config_url = Url::parse(OHTTP_CONFIG_URL)?;
    Ok(Request::get(parsed_config_url).send()?.body)
}

/// Encode the ping upload request in binary HTTP.
/// (draft-ietf-httpbis-binary-message)
#[cfg(not(feature = "felt"))]
fn bhttp_encode(upload_request: PingUploadRequest) -> Result<Vec<u8>, ViaductUploaderError> {
    let parsed_url = Url::parse(&upload_request.url)?;
    let mut message = bhttp::Message::request(
        "POST".into(),
        parsed_url.scheme().into(),
        parsed_url
            .host_str()
            .ok_or(ViaductUploaderError::Fatal)?
            .into(),
        parsed_url.path().into(),
    );

    upload_request
        .headers
        .into_iter()
        .for_each(|(k, v)| message.put_header(k, v));

    message.write_content(upload_request.body);

    let mut encoded = vec![];
    message.write_bhttp(bhttp::Mode::KnownLength, &mut encoded)?;

    Ok(encoded)
}

/// Unioned error across upload backends.
#[derive(Debug, thiserror::Error)]
enum ViaductUploaderError {
    #[error("bhttp::Error {0}")]
    Bhttp(#[from] bhttp::Error),

    #[error("ohttp::Error {0}")]
    Ohttp(#[from] ohttp::Error),

    #[error("viaduct::ViaductError {0}")]
    Viaduct(#[from] viaduct::ViaductError),

    #[cfg(feature = "felt")]
    #[error("enterprise::Error Unable to receive access_token")]
    EnterpriseErrorAccessToken,

    #[cfg(feature = "felt")]
    #[error("enterprise::Error No access token")]
    EnterpriseNoAccessToken,

    #[cfg(feature = "felt")]
    #[error("enterprise::Error Invalid console url {0}")]
    EnterpriseInvalidUrl(url::ParseError),

    #[cfg(feature = "felt")]
    #[error("enterprise::Error Console url not set")]
    EnterpriseUrlNotSet,

    #[cfg(not(feature = "felt"))]
    #[error("Fatal upload error")]
    Fatal,
}

impl From<url::ParseError> for ViaductUploaderError {
    fn from(e: url::ParseError) -> Self {
        ViaductUploaderError::Viaduct(viaduct::ViaductError::from(e))
    }
}
