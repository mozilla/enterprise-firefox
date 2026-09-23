/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! An entry point for sending a crash ping.

use crate::std::{env, io::stdin, path::PathBuf};
use crate::{glean, logging, net::ping};

/// What `CrashManager` writes to our stdin.
///
/// The console bearer token travels this way rather than in our environment,
/// which another process of the same user can read.
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PingInput {
    #[serde(default)]
    annotations: serde_json::Value,
    #[serde(default)]
    #[cfg_attr(not(feature = "enterprise"), allow(dead_code))]
    auth_token: Option<String>,
}

/// Resolve the enterprise console address for this run from the crash data
/// path.
///
/// `CrashManager` always passes `UAppData/Crash Reports`, so the parent of the
/// given path is the user application data directory holding `felt.json`.
#[cfg(all(not(mock), feature = "enterprise"))]
fn init_console_address(data_path: &::std::ffi::OsStr) {
    let app_data_dir = ::std::path::Path::new(data_path).parent();
    if let Err(e) = crate::enterprise_prefs::init_console_address(app_data_dir) {
        log::warn!("could not resolve the enterprise console address: {e:#}");
    }
}

pub fn main() {
    logging::init();

    let mut args = env::args_os().skip(2);
    let data_path = args.next().expect("no data path provided");
    let reason = args.next().expect("no crash reason provided");

    let input: PingInput =
        serde_json::from_reader(stdin()).expect("failed to read input from stdin");
    #[cfg(all(not(mock), feature = "enterprise"))]
    crate::net::auth::init_access_token(crate::net::auth::TokenSource::Stdin(input.auth_token));
    let extra = input.annotations;

    let profile_dir = extra
        .get("ProfileDirectory")
        .and_then(|v| v.as_str())
        .map(PathBuf::from);

    #[cfg(all(not(mock), feature = "enterprise"))]
    init_console_address(&data_path);

    #[cfg_attr(any(mock, not(feature = "enterprise")), allow(unused_mut))]
    let mut options = glean::InitOptions::new(data_path.into()).with_profile_dir(profile_dir);
    // No `ServerURL` annotation is available here, so the endpoint is derived
    // from the console address resolved above.
    #[cfg(all(not(mock), feature = "enterprise"))]
    options.set_server_endpoint(
        crate::enterprise_prefs::console_glean_url(None)
            .expect("failed to resolve the enterprise telemetry endpoint"),
    );
    let _glean_handle = options.init().expect("failed to acquire Glean store");

    ping::CrashPing {
        extra: &extra,
        reason: reason.to_str(),
    }
    .send();

    // Increase our chances of sending the ping immediately by explicitly shutting down Glean.
    ::glean::shutdown();
}

/// Just initialize Glean to allow any unsubmitted pings to be sent.
pub fn cleanup_main() {
    logging::init();

    let mut args = env::args_os().skip(2);
    let data_path = args.next().expect("no data path provided");
    let profile_dir = args.next();

    // Unlike `main`, there is nothing on stdin but the token, so a client run
    // by hand without any input is still able to flush the pending pings.
    #[cfg(all(not(mock), feature = "enterprise"))]
    {
        let input: PingInput = serde_json::from_reader(stdin()).unwrap_or_default();
        crate::net::auth::init_access_token(crate::net::auth::TokenSource::Stdin(input.auth_token));
    }

    #[cfg(all(not(mock), feature = "enterprise"))]
    init_console_address(&data_path);

    #[cfg_attr(any(mock, not(feature = "enterprise")), allow(unused_mut))]
    let mut options = glean::InitOptions::new(data_path.into()).with_profile_dir(profile_dir);
    #[cfg(all(not(mock), feature = "enterprise"))]
    options.set_server_endpoint(
        crate::enterprise_prefs::console_glean_url(None)
            .expect("failed to resolve the enterprise telemetry endpoint"),
    );
    let _glean_handle = options.init().expect("failed to acquire Glean store");

    // Sleep for a short period for Glean to do its thing in the background (and so that
    // `glean::shutdown()` won't log a warning about waiting for init to complete).
    std::thread::sleep(std::time::Duration::from_secs(2));

    // Glean shutdown will block (for a period) on at least one ping to be sent.
    ::glean::shutdown();
}
