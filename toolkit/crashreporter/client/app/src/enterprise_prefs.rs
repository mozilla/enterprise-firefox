/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Enterprise console preferences and endpoint URLs.
//!
//! Concentrates the enterprise console address resolution and the hard-coded
//! console endpoint paths used for crash report submission and Glean telemetry.
//!
//! The console address normally comes from the `ServerURL` crash annotation
//! (recorded by the browser once AutoConfig has run). A crash before then has
//! no usable annotation, so we recover the address by reading the AutoConfig
//! (`.cfg`) file ourselves. The extraction and the resolution of the generic
//! build placeholder (environment variable, then `felt.json`) live in the
//! shared enterprise-console crate; this module only does the IO through the
//! mockable `crate::std`.

use crate::config::installation_resource_path;
use crate::std::path::Path;
use anyhow::Context;
use enterprise_console::{
    console_address_from_autoconfig, resolve_console_address, CONSOLE_ADDRESS_ENV,
    CONSOLE_ADDRESS_PREF, FELT_STORAGE_FILENAME,
};
use url::Url;

/// The enterprise AutoConfig file name. Enterprise builds point
/// `general.config.filename` at this (set in `firefox-branding.js`); it is not
/// a default value anywhere else.
const ENTERPRISE_AUTOCONFIG_FILENAME: &str = "firefox.cfg";

/// Path appended to the console address to form the crash submission endpoint.
const CRASH_SUBMIT_PATH: &str = "api/browser/crash-reports/submit";

/// Path appended to the console address to form the Glean telemetry endpoint.
const GLEAN_SUBMIT_PATH: &str = "api/browser/telemetry";

/// Resolve the crash report submission URL.
///
/// Prefers `server_url` (the `ServerURL` crash annotation) when it is already
/// an absolute URL, since that is the submission endpoint itself. Otherwise
/// (missing, or a domainless placeholder such as `/submit?...`) constructs the
/// endpoint from the enterprise console address.
///
/// `app_data_dir` is the user application data directory (the top-level
/// Firefox directory holding `profiles.ini` and the profiles), where
/// `felt.json` is stored on generic builds.
pub fn console_report_url(
    server_url: Option<&str>,
    app_data_dir: Option<&Path>,
) -> anyhow::Result<String> {
    if let Some(server_url) = server_url {
        if Url::parse(server_url).is_ok() {
            return Ok(server_url.to_owned());
        }
    }
    Ok(format!(
        "{}/{}",
        console_base(None, app_data_dir)?,
        CRASH_SUBMIT_PATH
    ))
}

/// Construct the Glean telemetry endpoint from the enterprise console address.
///
/// `server_url` is the `ServerURL` crash annotation, when available.
/// `app_data_dir` is the user application data directory, see
/// [`console_report_url`].
pub fn console_glean_url(
    server_url: Option<&str>,
    app_data_dir: Option<&Path>,
) -> anyhow::Result<String> {
    let base = console_base(server_url, app_data_dir)?;
    let mut url = Url::parse(&base)?;
    url.set_path(&format!(
        "{}/{}",
        url.path().trim_end_matches('/'),
        GLEAN_SUBMIT_PATH
    ));
    Ok(url.to_string())
}

/// Whether `url` is on the configured enterprise console.
///
/// Unlike [`console_base`], the console address is only taken from AutoConfig:
/// the URL being validated cannot vouch for itself.
pub fn is_console_url(url: &str) -> bool {
    match same_origin_as_console(url) {
        Ok(result) => result,
        Err(e) => {
            log::warn!("could not check {url} against the enterprise console address: {e:#}");
            false
        }
    }
}

fn same_origin_as_console(url: &str) -> anyhow::Result<bool> {
    let url = Url::parse(url)?;
    let console = Url::parse(&read_autoconfig_string_pref(CONSOLE_ADDRESS_PREF)?)?;
    let origin = url.origin();
    // Opaque origins (such as that of a `data:` URL) must never match, not even
    // each other.
    Ok(origin.is_tuple() && origin == console.origin())
}

/// Resolve the enterprise console base URL (without a trailing slash).
///
/// Resolution order:
/// 1. `server_url` (the `ServerURL` crash annotation, i.e. the submission
///    endpoint) by stripping the submission path back to the base;
/// 2. the AutoConfig file; when it holds the generic build placeholder, the
///    environment variable and then the felt storage file in `app_data_dir`
///    (see the enterprise-console crate).
fn console_base(server_url: Option<&str>, app_data_dir: Option<&Path>) -> anyhow::Result<String> {
    if let Some(server_url) = server_url {
        let trimmed = server_url.trim_end_matches('/');
        if let Some(base) = trimmed.strip_suffix(CRASH_SUBMIT_PATH) {
            return Ok(base.trim_end_matches('/').to_owned());
        }
    }
    let address = autoconfig_console_address()?;
    let env_value = crate::std::env::var(CONSOLE_ADDRESS_ENV).ok();
    let base = resolve_console_address(&address, env_value.as_deref(), || {
        let dir = app_data_dir.ok_or_else(|| {
            crate::std::io::Error::new(
                crate::std::io::ErrorKind::NotFound,
                "no application data directory to locate the felt storage file",
            )
        })?;
        crate::std::fs::read(&dir.join(FELT_STORAGE_FILENAME))
    })
    .context("could not resolve the generic build console address placeholder")?;
    Ok(base.trim_end_matches('/').to_owned())
}

/// Read the console address (or the generic build placeholder) out of the
/// installation's AutoConfig file.
fn autoconfig_console_address() -> anyhow::Result<String> {
    let path = installation_resource_path().join(ENTERPRISE_AUTOCONFIG_FILENAME);
    let contents = crate::std::fs::read(&path)?;
    console_address_from_autoconfig(&contents).with_context(|| {
        format!(
            "could not find pref {CONSOLE_ADDRESS_PREF:?} in {}",
            path.display()
        )
    })
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::std::{fs::MockFS, fs::MockFiles, mock};

    const CFG: &str = "// first line is ignored\n\
         lockPref(\"enterprise.console.address\", \"https://console.example.com/foo/\");";

    /// Byte-shift plaintext into an encoded AutoConfig file.
    fn encode(plaintext: &str) -> Vec<u8> {
        plaintext
            .bytes()
            .map(|b| b.wrapping_add(enterprise_console::DEFAULT_OBSCURE_VALUE))
            .collect()
    }

    fn with_autoconfig<R>(body: impl FnOnce() -> R) -> R {
        let mock_files = MockFiles::new();
        mock_files.add_dir("work_dir");
        mock_files.add_file("work_dir/firefox.cfg", encode(CFG));
        mock::builder()
            .set(MockFS, mock_files.clone())
            .set(
                crate::std::env::MockCurrentExe,
                "work_dir/crashreporter".into(),
            )
            .run(body)
    }

    const GENERIC_CFG: &str = "// first line is ignored\n\
         lockPref(\"enterprise.console.address\", \"FIREFOX_ENTERPRISE_GENERIC\");";

    fn with_generic_autoconfig<R>(
        felt_json: Option<&str>,
        configure: impl FnOnce(&mut mock::Builder),
        body: impl FnOnce() -> R,
    ) -> R {
        let mock_files = MockFiles::new();
        mock_files.add_dir("work_dir");
        mock_files.add_file("work_dir/firefox.cfg", encode(GENERIC_CFG));
        mock_files.add_dir("app_data");
        if let Some(felt_json) = felt_json {
            mock_files.add_file("app_data/felt.json", felt_json);
        }
        let mut builder = mock::builder();
        builder.set(MockFS, mock_files.clone()).set(
            crate::std::env::MockCurrentExe,
            "work_dir/crashreporter".into(),
        );
        configure(&mut builder);
        builder.run(body)
    }

    #[test]
    fn console_base_prefers_annotation() {
        // No file access needed: the submission path is stripped to the base.
        assert_eq!(
            console_base(
                Some("https://console.example.com/foo/api/browser/crash-reports/submit"),
                None
            )
            .unwrap(),
            "https://console.example.com/foo"
        );
    }

    #[test]
    fn console_base_reads_encoded_autoconfig() {
        with_autoconfig(|| {
            assert_eq!(
                console_base(None, None).unwrap(),
                "https://console.example.com/foo"
            );
        });
    }

    #[test]
    fn console_base_errors_without_source() {
        let mock_files = MockFiles::new();
        mock::builder()
            .set(MockFS, mock_files.clone())
            .set(
                crate::std::env::MockCurrentExe,
                "work_dir/crashreporter".into(),
            )
            .run(|| {
                assert!(console_base(None, None).is_err());
            });
    }

    #[test]
    fn console_base_generic_uses_environment() {
        with_generic_autoconfig(
            None,
            |builder| {
                builder.set(
                    crate::std::env::MockEnv(CONSOLE_ADDRESS_ENV.into()),
                    "https://env.example.com/".into(),
                );
            },
            || {
                assert_eq!(
                    console_base(None, Some((&"app_data").as_ref())).unwrap(),
                    "https://env.example.com"
                );
            },
        );
    }

    #[test]
    fn console_base_generic_reads_felt_storage() {
        with_generic_autoconfig(
            Some(r#"{"consoleAddress": "https://stored.example.com/"}"#),
            |_| {},
            || {
                assert_eq!(
                    console_base(None, Some((&"app_data").as_ref())).unwrap(),
                    "https://stored.example.com"
                );
            },
        );
    }

    #[test]
    fn console_base_generic_errors_without_stored_address() {
        with_generic_autoconfig(
            Some(r#"{"deviceId": "abc"}"#),
            |_| {},
            || {
                assert!(console_base(None, Some((&"app_data").as_ref())).is_err());
            },
        );
    }

    #[test]
    fn console_base_generic_errors_without_app_data_dir() {
        with_generic_autoconfig(
            Some(r#"{"consoleAddress": "https://stored.example.com/"}"#),
            |_| {},
            || {
                assert!(console_base(None, None).is_err());
            },
        );
    }

    #[test]
    fn report_url_uses_valid_annotation() -> anyhow::Result<()> {
        // An absolute annotation is the submission endpoint; return it as-is.
        assert_eq!(
            console_report_url(
                Some("https://console.example.com/foo/api/browser/crash-reports/submit"),
                None
            )?,
            "https://console.example.com/foo/api/browser/crash-reports/submit"
        );
        anyhow::Ok(())
    }

    #[test]
    fn report_url_constructs_when_annotation_unusable() -> anyhow::Result<()> {
        // A domainless placeholder is ignored; the URL is built from AutoConfig.
        with_autoconfig(|| {
            assert_eq!(
                console_report_url(Some("/submit?id=x"), None)?,
                "https://console.example.com/foo/api/browser/crash-reports/submit"
            );
            anyhow::Ok(())
        })
    }

    #[test]
    fn console_url_matches_console_origin() {
        with_autoconfig(|| {
            // Any path on the console origin is the console.
            assert!(is_console_url(
                "https://console.example.com/foo/api/browser/crash-reports/submit"
            ));
            assert!(is_console_url("https://console.example.com/"));
        });
    }

    #[test]
    fn console_url_rejects_other_urls() {
        with_autoconfig(|| {
            // A different host, scheme or port is not the console.
            assert!(!is_console_url("https://evil.example.com/foo"));
            assert!(!is_console_url("http://console.example.com/foo"));
            assert!(!is_console_url("https://console.example.com:8443/foo"));
            // Nor is a url with an opaque origin, or one we cannot parse.
            assert!(!is_console_url("data:text/plain,hello"));
            assert!(!is_console_url("/submit?id=x"));
        });
    }

    #[test]
    fn console_url_rejects_without_autoconfig() {
        let mock_files = MockFiles::new();
        mock::builder()
            .set(MockFS, mock_files.clone())
            .set(
                crate::std::env::MockCurrentExe,
                "work_dir/crashreporter".into(),
            )
            .run(|| {
                assert!(!is_console_url("https://console.example.com/foo"));
            });
    }

    #[test]
    fn glean_url_appends_telemetry_path_from_annotation() -> anyhow::Result<()> {
        // Derived from the ServerURL annotation without touching the filesystem.
        assert_eq!(
            console_glean_url(
                Some("https://console.example.com/foo/api/browser/crash-reports/submit"),
                None
            )?,
            "https://console.example.com/foo/api/browser/telemetry"
        );
        anyhow::Ok(())
    }
}
