/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Best-effort Felt bearer token for authenticating enterprise crash uploads.
//!
//! In Firefox Enterprise, crash reports and crash pings are uploaded to the
//! admin console, which requires the same bearer token used for other console
//! communication. The crashing Firefox process exports its current access token
//! into its environment as `MOZ_CRASHREPORTER_AUTH_TOKEN`; the crash reporter
//! client (and the `crashreporterNetworkBackend` background task it may spawn)
//! inherit that environment and attach it as an `Authorization` header.
//!
//! This is best-effort: only the access token that was valid at crash time is
//! available (the refresh token never leaves the Felt UI process), so there is
//! no way to refresh it here. If the token is missing or the server rejects it,
//! the upload is sent unauthenticated (and a pending report is retried later by
//! an authenticated in-process session).

/// Return an `Authorization: Bearer` header built from the access token that
/// the crashing process exported into the environment, or `None` if no token is
/// present (non-enterprise builds, or a crash before sign-in).
pub fn enterprise_authorization_header() -> Option<(String, String)> {
    let token = crate::std::env::var(ekey!("AUTH_TOKEN")).ok()?;
    if token.is_empty() {
        return None;
    }
    Some(("Authorization".to_owned(), format!("Bearer {token}")))
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::std::{env::MockEnv, mock};

    fn run_with_env(value: Option<&str>) -> Option<(String, String)> {
        let mut builder = mock::builder();
        if let Some(value) = value {
            builder.set(MockEnv(ekey!("AUTH_TOKEN").into()), value.to_owned());
        }
        builder.run(enterprise_authorization_header)
    }

    #[test]
    fn token_present_yields_header() {
        let header = run_with_env(Some("abc")).expect("expected a header");
        assert_eq!(header.0, "Authorization");
        assert_eq!(header.1, "Bearer abc");
    }

    #[test]
    fn empty_token_yields_none() {
        assert!(run_with_env(Some("")).is_none());
    }

    #[test]
    fn missing_token_yields_none() {
        assert!(run_with_env(None).is_none());
    }
}
