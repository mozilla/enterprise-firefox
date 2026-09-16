/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Best-effort Felt bearer token for authenticating enterprise crash uploads.
//!
//! In Firefox Enterprise, crash reports and crash pings are uploaded to the
//! admin console, which requires the same bearer token used for other console
//! communication. On unix the crashing Firefox process passes its current access
//! token to the crash reporter over an inherited pipe, exporting only the pipe's
//! fd number as `MOZ_CRASHREPORTER_AUTH_TOKEN_FD`; this keeps the token out of
//! our environment, which a same-user process could otherwise read via
//! `/proc/<pid>/environ`. On Windows the token is passed in the environment as
//! `MOZ_CRASHREPORTER_AUTH_TOKEN`. Either way the client reads it once and
//! attaches it as an `Authorization` header; the `crashreporterNetworkBackend`
//! background task receives the already-built header, not the raw token.
//!
//! This is best-effort: only the access token that was valid at crash time is
//! available (the refresh token never leaves the Felt UI process), so there is
//! no way to refresh it here. If the token is missing or the server rejects it,
//! the upload is sent unauthenticated (and a pending report is retried later by
//! an authenticated in-process session).

/// Return an `Authorization: Bearer` header for an upload to `url`, built from
/// the access token that the crashing process exported into the environment.
///
/// Returns `None` if no token is present (non-enterprise builds, or a crash
/// before sign-in), or if `url` is not on the enterprise console.
pub fn enterprise_authorization_header(url: &str) -> Option<(String, String)> {
    let token = access_token()?;
    if token.is_empty() {
        return None;
    }
    if !crate::enterprise_prefs::is_console_url(url) {
        log::warn!("not authenticating the upload: {url} is not the enterprise console");
        return None;
    }
    Some(("Authorization".to_owned(), format!("Bearer {token}")))
}

/// The token, read once at startup. See [`init_access_token`].
#[cfg(not(mock))]
static ACCESS_TOKEN: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// Read the access token, and must be the very first thing the client does.
///
/// This has to run before `fd_cleanup::cleanup_unused_fds()`, which closes every
/// fd >= 3 and would otherwise close the inherited token pipe before we read it
/// — and leave the fd number free to be reused by an unrelated file, which we
/// would then read as if it were the token.
///
/// Reading eagerly also drains the pipe immediately, so the token sits in a
/// kernel buffer reachable through `/proc/<pid>/fd` for a few microseconds of
/// startup rather than for as long as the crash reporter window is open.
#[cfg(not(mock))]
pub fn init_access_token() {
    let _ = ACCESS_TOKEN.set(read_access_token());
}

#[cfg(not(mock))]
fn access_token() -> Option<String> {
    ACCESS_TOKEN.get_or_init(read_access_token).clone()
}

/// Each test case sets up its own environment, so don't cache across them.
#[cfg(mock)]
fn access_token() -> Option<String> {
    read_access_token()
}

/// Read the console access token the crashing process handed to us. On unix it
/// arrives over an inherited pipe whose fd number is in
/// `MOZ_CRASHREPORTER_AUTH_TOKEN_FD`, so the token itself is not present in our
/// environment (where a same-user process could read it via
/// `/proc/<pid>/environ`). On Windows it is passed directly in
/// `MOZ_CRASHREPORTER_AUTH_TOKEN`.
fn read_access_token() -> Option<String> {
    #[cfg(unix)]
    if let Ok(fd) = crate::std::env::var(ekey!("AUTH_TOKEN_FD")) {
        return read_token_from_fd(&fd);
    }
    crate::std::env::var(ekey!("AUTH_TOKEN")).ok()
}

/// Read the token from the inherited pipe fd, taking ownership of the fd so it is
/// closed when we are done. Returns `None` on any error, in which case the
/// upload is sent unauthenticated.
#[cfg(unix)]
fn read_token_from_fd(fd: &str) -> Option<String> {
    use std::io::Read;
    use std::os::fd::{FromRawFd, RawFd};

    let fd: RawFd = fd.parse().ok()?;
    // SAFETY: the crashing process handed us this fd (the read end of a pipe)
    // specifically to inherit; we take sole ownership of it here.
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let mut token = String::new();
    file.read_to_string(&mut token).ok()?;
    let token = token.trim_end_matches(['\r', '\n']).to_owned();
    (!token.is_empty()).then_some(token)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::std::{
        env::{MockCurrentExe, MockEnv},
        fs::{MockFS, MockFiles},
        mock,
    };

    const CONSOLE_URL: &str = "https://console.example.com/api/browser/crash-reports/submit";

    fn run_with_env(value: Option<&str>, url: &str) -> Option<(String, String)> {
        let files = MockFiles::new();
        files.add_dir("work_dir").add_file(
            "work_dir/firefox.cfg",
            crate::test::enterprise_autoconfig("https://console.example.com"),
        );

        let mut builder = mock::builder();
        builder
            .set(MockFS, files)
            .set(MockCurrentExe, "work_dir/crashreporter".into());
        if let Some(value) = value {
            builder.set(MockEnv(ekey!("AUTH_TOKEN").into()), value.to_owned());
        }
        builder.run(|| enterprise_authorization_header(url))
    }

    #[test]
    fn token_present_yields_header() {
        let header = run_with_env(Some("abc"), CONSOLE_URL).expect("expected a header");
        assert_eq!(header.0, "Authorization");
        assert_eq!(header.1, "Bearer abc");
    }

    #[test]
    fn empty_token_yields_none() {
        assert!(run_with_env(Some(""), CONSOLE_URL).is_none());
    }

    #[test]
    fn missing_token_yields_none() {
        assert!(run_with_env(None, CONSOLE_URL).is_none());
    }

    #[test]
    fn non_console_url_yields_none() {
        assert!(run_with_env(Some("abc"), "https://evil.example.com/submit").is_none());
    }

    #[cfg(unix)]
    fn run_with_fd(token: &[u8], url: &str) -> Option<(String, String)> {
        use std::io::Write;
        use std::os::fd::IntoRawFd;

        let files = MockFiles::new();
        files.add_dir("work_dir").add_file(
            "work_dir/firefox.cfg",
            crate::test::enterprise_autoconfig("https://console.example.com"),
        );

        let (reader, mut writer) = std::io::pipe().expect("failed to create pipe");
        writer.write_all(token).expect("failed to write token");
        drop(writer); // the reader sees EOF after the token
        let fd = reader.into_raw_fd();

        let mut builder = mock::builder();
        builder
            .set(MockFS, files)
            .set(MockCurrentExe, "work_dir/crashreporter".into())
            .set(MockEnv(ekey!("AUTH_TOKEN_FD").into()), fd.to_string());
        builder.run(|| enterprise_authorization_header(url))
    }

    #[cfg(unix)]
    #[test]
    fn token_from_fd_yields_header() {
        let header = run_with_fd(b"abc", CONSOLE_URL).expect("expected a header");
        assert_eq!(header.0, "Authorization");
        assert_eq!(header.1, "Bearer abc");
    }

    #[cfg(unix)]
    #[test]
    fn empty_token_from_fd_yields_none() {
        assert!(run_with_fd(b"", CONSOLE_URL).is_none());
    }
}
