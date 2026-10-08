/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! An entry point for sending a crash ping.

use crate::std::{env, io::stdin, path::PathBuf};
use crate::{glean, logging, net::ping};

/// The user application data directory, derived from the crash data path.
///
/// `CrashManager` always passes `UAppData/Crash Reports`, so the parent of the
/// given path is the directory holding `felt.json`.
#[cfg(all(not(mock), feature = "enterprise"))]
fn app_data_dir(data_path: &::std::ffi::OsStr) -> Option<::std::path::PathBuf> {
    ::std::path::Path::new(data_path)
        .parent()
        .map(::std::path::Path::to_path_buf)
}

pub fn main() {
    logging::init();

    let mut args = env::args_os().skip(2);
    let data_path = args.next().expect("no data path provided");
    let reason = args.next().expect("no crash reason provided");

    let extra: serde_json::Value =
        serde_json::from_reader(stdin()).expect("failed to read extra data from stdin");

    let profile_dir = extra
        .get("ProfileDirectory")
        .and_then(|v| v.as_str())
        .map(PathBuf::from);

    #[cfg(all(not(mock), feature = "enterprise"))]
    let app_data_dir = app_data_dir(&data_path);

    #[cfg_attr(any(mock, not(feature = "enterprise")), allow(unused_mut))]
    let mut options = glean::InitOptions::new(data_path.into()).with_profile_dir(profile_dir);
    // No `ServerURL` annotation is available here, so the endpoint is derived
    // from the console address in AutoConfig (or, on generic builds, the
    // environment variable or felt.json).
    #[cfg(all(not(mock), feature = "enterprise"))]
    options.set_server_endpoint(
        crate::enterprise_prefs::console_glean_url(None, app_data_dir.as_deref())
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

    #[cfg(all(not(mock), feature = "enterprise"))]
    let app_data_dir = app_data_dir(&data_path);

    #[cfg_attr(any(mock, not(feature = "enterprise")), allow(unused_mut))]
    let mut options = glean::InitOptions::new(data_path.into()).with_profile_dir(profile_dir);
    #[cfg(all(not(mock), feature = "enterprise"))]
    options.set_server_endpoint(
        crate::enterprise_prefs::console_glean_url(None, app_data_dir.as_deref())
            .expect("failed to resolve the enterprise telemetry endpoint"),
    );
    let _glean_handle = options.init().expect("failed to acquire Glean store");

    // Sleep for a short period for Glean to do its thing in the background (and so that
    // `glean::shutdown()` won't log a warning about waiting for init to complete).
    std::thread::sleep(std::time::Duration::from_secs(2));

    // Glean shutdown will block (for a period) on at least one ping to be sent.
    ::glean::shutdown();
}
