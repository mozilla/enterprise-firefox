/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Enterprise console preferences and endpoint URLs.
//!
//! Concentrates the enterprise console address resolution and the hard-coded
//! console endpoint paths used for crash report submission and Glean telemetry.
//!
//! The address is read from the installation's AutoConfig (`.cfg`) file, once
//! per run via [`init_console_address`]. The extraction and the resolution of
//! the generic build placeholder (environment variable, then `felt.json`) live
//! in the shared enterprise-console crate; this module only does the IO through
//! the mockable `crate::std`.
//!
//! The submission endpoints additionally honour the `ServerURL` crash
//! annotation (recorded by the browser once AutoConfig has run), which a crash
//! before then does not have. [`is_console_url`] never does: it answers what an
//! upload may be authenticated against, and a URL cannot vouch for itself.

use crate::config::installation_resource_path;
use crate::std::path::Path;
use anyhow::Context;
use enterprise_console::{
    console_address_from_autoconfig, resolve_console_address, CONSOLE_ADDRESS_ENV,
    CONSOLE_ADDRESS_PREF, FELT_STORAGE_FILENAME,
};
use mozbuild::config::MOZ_APP_NAME;
use url::Url;

/// Path appended to the console address to form the crash submission endpoint.
const CRASH_SUBMIT_PATH: &str = "api/browser/crash-reports/submit";

/// Path appended to the console address to form the Glean telemetry endpoint.
const GLEAN_SUBMIT_PATH: &str = "api/browser/telemetry";

/// The console address for this run, as resolved by [`init_console_address`].
///
/// Resolving reads files and needs the user application data directory, which
/// only the entry points know; doing it once at startup lets the rest of the
/// run - including the Glean uploader, from its own thread - just compare
/// against the result.
#[cfg(not(mock))]
static CONSOLE_ADDRESS: std::sync::OnceLock<String> = std::sync::OnceLock::new();

// Mock runs resolve different addresses in the same process, so the address is
// cached per thread there, just like the mocked state it is resolved from.
#[cfg(mock)]
thread_local! {
    static CONSOLE_ADDRESS: ::std::cell::OnceCell<String> = const { ::std::cell::OnceCell::new() };
}

#[cfg(not(mock))]
fn cache_console_address(address: &str) {
    let _ = CONSOLE_ADDRESS.set(address.to_owned());
}

#[cfg(not(mock))]
fn cached_console_address() -> Option<String> {
    CONSOLE_ADDRESS.get().cloned()
}

#[cfg(mock)]
fn cache_console_address(address: &str) {
    CONSOLE_ADDRESS.with(|cell| {
        let _ = cell.set(address.to_owned());
    });
}

#[cfg(mock)]
fn cached_console_address() -> Option<String> {
    CONSOLE_ADDRESS.with(|cell| cell.get().cloned())
}

/// Resolve the enterprise console address for this run, caching it for
/// [`is_console_url`] and the endpoint functions below.
///
/// Entry points call this before anything is uploaded. `app_data_dir` is the
/// user application data directory (the top-level Firefox directory holding
/// `profiles.ini` and the profiles), where `felt.json` is stored on generic
/// builds.
///
/// The `ServerURL` crash annotation is deliberately not an input: the address
/// recorded here is what an upload URL is checked against, and a URL cannot
/// vouch for itself.
pub fn init_console_address(app_data_dir: Option<&Path>) -> anyhow::Result<()> {
    cache_console_address(&read_console_address(app_data_dir)?);
    Ok(())
}

/// The console address for this run, without a trailing slash.
fn console_address() -> anyhow::Result<String> {
    if let Some(address) = cached_console_address() {
        return Ok(address);
    }
    // `init_console_address` has not run (in a mock run, possibly not on this
    // thread). Fall back to what can be resolved without the application data
    // directory.
    read_console_address(None)
}

/// The console address implied by `server_url` (the `ServerURL` crash
/// annotation), when it is the console submission endpoint.
fn base_from_server_url(server_url: Option<&str>) -> Option<String> {
    let trimmed = server_url?.trim_end_matches('/');
    Some(
        trimmed
            .strip_suffix(CRASH_SUBMIT_PATH)?
            .trim_end_matches('/')
            .to_owned(),
    )
}

/// Resolve the crash report submission URL.
///
/// Prefers `server_url` (the `ServerURL` crash annotation) when it is already
/// an absolute URL, since that is the submission endpoint itself. Otherwise
/// (missing, or a domainless placeholder such as `/submit?...`) constructs the
/// endpoint from the enterprise console address.
pub fn console_report_url(server_url: Option<&str>) -> anyhow::Result<String> {
    if let Some(server_url) = server_url {
        if Url::parse(server_url).is_ok() {
            return Ok(server_url.to_owned());
        }
    }
    Ok(format!("{}/{}", console_address()?, CRASH_SUBMIT_PATH))
}

/// Construct the Glean telemetry endpoint from the enterprise console address.
///
/// `server_url` is the `ServerURL` crash annotation, when available.
pub fn console_glean_url(server_url: Option<&str>) -> anyhow::Result<String> {
    let base = match base_from_server_url(server_url) {
        Some(base) => base,
        None => console_address()?,
    };
    let mut url = Url::parse(&base)?;
    url.set_path(&format!(
        "{}/{}",
        url.path().trim_end_matches('/'),
        GLEAN_SUBMIT_PATH
    ));
    Ok(url.to_string())
}

/// Whether `url` is on the enterprise console resolved for this run.
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
    let console = Url::parse(&console_address()?)?;
    let origin = url.origin();
    // Opaque origins (such as that of a `data:` URL) must never match, not even
    // each other.
    Ok(origin.is_tuple() && origin == console.origin())
}

/// Read the enterprise console address (without a trailing slash) from the
/// AutoConfig file; when it holds the generic build placeholder, from the
/// environment variable and then the felt storage file in `app_data_dir` (see
/// the enterprise-console crate).
fn read_console_address(app_data_dir: Option<&Path>) -> anyhow::Result<String> {
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
    let path = installation_resource_path().join(format!("{}.cfg", MOZ_APP_NAME));
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
        mock_files.add_file(format!("work_dir/{}.cfg", MOZ_APP_NAME), encode(CFG));
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
        mock_files.add_file(
            format!("work_dir/{}.cfg", MOZ_APP_NAME),
            encode(GENERIC_CFG),
        );
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
    fn base_from_annotation_strips_submission_path() {
        // No file access needed: the submission path is stripped to the base.
        assert_eq!(
            base_from_server_url(Some(
                "https://console.example.com/foo/api/browser/crash-reports/submit"
            ))
            .unwrap(),
            "https://console.example.com/foo"
        );
        // An annotation that isn't the submission endpoint implies nothing.
        assert!(base_from_server_url(Some("/submit?id=x")).is_none());
        assert!(base_from_server_url(None).is_none());
    }

    #[test]
    fn console_address_reads_encoded_autoconfig() {
        with_autoconfig(|| {
            assert_eq!(
                read_console_address(None).unwrap(),
                "https://console.example.com/foo"
            );
        });
    }

    #[test]
    fn console_address_errors_without_source() {
        let mock_files = MockFiles::new();
        mock::builder()
            .set(MockFS, mock_files.clone())
            .set(
                crate::std::env::MockCurrentExe,
                "work_dir/crashreporter".into(),
            )
            .run(|| {
                assert!(read_console_address(None).is_err());
            });
    }

    #[test]
    fn console_address_generic_uses_environment() {
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
                    read_console_address(Some((&"app_data").as_ref())).unwrap(),
                    "https://env.example.com"
                );
            },
        );
    }

    #[test]
    fn console_address_generic_reads_felt_storage() {
        with_generic_autoconfig(
            Some(r#"{"consoleAddress": "https://stored.example.com/"}"#),
            |_| {},
            || {
                assert_eq!(
                    read_console_address(Some((&"app_data").as_ref())).unwrap(),
                    "https://stored.example.com"
                );
            },
        );
    }

    #[test]
    fn console_address_generic_errors_without_stored_address() {
        with_generic_autoconfig(
            Some(r#"{"deviceId": "abc"}"#),
            |_| {},
            || {
                assert!(read_console_address(Some((&"app_data").as_ref())).is_err());
            },
        );
    }

    #[test]
    fn console_address_generic_errors_without_app_data_dir() {
        with_generic_autoconfig(
            Some(r#"{"consoleAddress": "https://stored.example.com/"}"#),
            |_| {},
            || {
                assert!(read_console_address(None).is_err());
            },
        );
    }

    #[test]
    fn report_url_uses_valid_annotation() -> anyhow::Result<()> {
        // An absolute annotation is the submission endpoint; return it as-is.
        assert_eq!(
            console_report_url(Some(
                "https://console.example.com/foo/api/browser/crash-reports/submit"
            ))?,
            "https://console.example.com/foo/api/browser/crash-reports/submit"
        );
        anyhow::Ok(())
    }

    #[test]
    fn report_url_constructs_when_annotation_unusable() -> anyhow::Result<()> {
        // A domainless placeholder is ignored; the URL is built from AutoConfig.
        with_autoconfig(|| {
            assert_eq!(
                console_report_url(Some("/submit?id=x"))?,
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
    fn console_url_uses_the_initialized_address() {
        // On a generic build the AutoConfig address is only a placeholder, so
        // the check relies on the address resolved at startup.
        with_generic_autoconfig(
            Some(r#"{"consoleAddress": "https://stored.example.com/"}"#),
            |_| {},
            || {
                let url = "https://stored.example.com/api/browser/telemetry";
                // Uninitialized, the placeholder is all there is and nothing matches.
                assert!(!is_console_url(url));

                init_console_address(Some((&"app_data").as_ref())).unwrap();
                assert!(is_console_url(url));
                assert!(!is_console_url("https://evil.example.com/foo"));
            },
        );
    }

    #[test]
    fn endpoints_use_the_initialized_address() -> anyhow::Result<()> {
        with_generic_autoconfig(
            Some(r#"{"consoleAddress": "https://stored.example.com/"}"#),
            |_| {},
            || {
                init_console_address(Some((&"app_data").as_ref()))?;
                assert_eq!(
                    console_report_url(None)?,
                    "https://stored.example.com/api/browser/crash-reports/submit"
                );
                assert_eq!(
                    console_glean_url(None)?,
                    "https://stored.example.com/api/browser/telemetry"
                );
                anyhow::Ok(())
            },
        )
    }

    #[test]
    fn glean_url_appends_telemetry_path_from_annotation() -> anyhow::Result<()> {
        // Derived from the ServerURL annotation without touching the filesystem.
        assert_eq!(
            console_glean_url(Some(
                "https://console.example.com/foo/api/browser/crash-reports/submit"
            ))?,
            "https://console.example.com/foo/api/browser/telemetry"
        );
        anyhow::Ok(())
    }
}
