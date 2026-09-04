/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
#![allow(clippy::not_unsafe_ptr_arg_deref)]

use log::trace;
use std::os::raw::c_char;
use std::{ffi::CStr, sync::atomic::AtomicBool};

use std::env;
use std::sync::{atomic::Ordering, Mutex};

#[macro_use]
extern crate cstr;
#[macro_use]
extern crate xpcom;
extern crate thin_vec;

mod client;
mod components;
mod edr_checker;
#[cfg(target_os = "linux")]
mod edr_checker_linux;
#[cfg(target_os = "macos")]
mod edr_checker_macos;
#[cfg(target_os = "windows")]
mod edr_checker_win;
mod message;
mod utils;

pub use utils::{CONSOLE_URL, TOKENS};

static IS_FELT_UI: AtomicBool = AtomicBool::new(false);
static IS_FELT_BROWSER: AtomicBool = AtomicBool::new(false);
static IS_FELT_SAFE_MODE: AtomicBool = AtomicBool::new(false);

fn normalize_arg(arg: String) -> String {
    let mut normalized = arg;
    normalized.retain(|c| c != '-' && c != '/');
    normalized.to_lowercase()
}

fn arg_matches(target: &str) -> bool {
    env::args()
        .into_iter()
        .any(|arg| normalize_arg(arg) == target)
}

fn has_env(target: &str) -> bool {
    match env::var(target) {
        Ok(v) => v == "1",
        Err(_) => false,
    }
}

#[no_mangle]
pub extern "C" fn felt_init() {
    trace!("felt_init()");
    env_logger::init();

    let found_felt_ui_env = has_env("MOZ_FELT_UI");
    let bypass_env = has_env("MOZ_BYPASS_FELT");

    // There may be a -chrome ... being passed on the CLI, e.g. for jsdebugger
    // in this case, it is not expected the FELT UI is shown, not the browser UI
    let force_chrome = arg_matches("chrome");
    trace!("felt_init(): force_chrome={}", force_chrome);

    let felt_ui_requested = arg_matches("feltui") || found_felt_ui_env;
    let is_felt_browser = arg_matches("felt") && !force_chrome;

    if is_felt_browser && felt_ui_requested {
        panic!("Cannot have both -feltUI and -felt args");
    }

    let is_felt_ui = !is_felt_browser && !bypass_env && !force_chrome;
    trace!("felt_init(): is_felt_ui={}", is_felt_ui);
    IS_FELT_UI.store(is_felt_ui, Ordering::Relaxed);

    trace!("felt_init(): is_felt_browser={}", is_felt_browser);
    IS_FELT_BROWSER.store(is_felt_browser, Ordering::Relaxed);

    let is_felt_safe_mode = arg_matches("safemode");
    trace!("felt_init(): is_felt_safe_mode={}", is_felt_safe_mode);
    IS_FELT_SAFE_MODE.store(is_felt_safe_mode, Ordering::Relaxed);

    trace!("felt_init() done");
}

#[no_mangle]
pub extern "C" fn is_felt_ui() -> bool {
    trace!("is_felt_ui()");
    IS_FELT_UI.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn is_felt_safe_mode() -> bool {
    trace!("is_felt_safe_mode()");
    IS_FELT_SAFE_MODE.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn is_felt_browser() -> bool {
    trace!("is_felt_browser()");
    IS_FELT_BROWSER.load(Ordering::Relaxed)
}

pub static FELT_CLIENT: Mutex<Option<client::FeltClientThread>> = Mutex::new(None);

#[no_mangle]
pub extern "C" fn firefox_connect_to_felt(server_name: *const c_char) -> bool {
    let srv_name = unsafe { CStr::from_ptr(server_name) };
    let server_socket = String::from_utf8_lossy(srv_name.to_bytes()).to_string();
    trace!("firefox_connect_to_felt({})", server_socket);
    match client::FeltClientThread::new(server_socket) {
        Ok(client) => {
            let mut state = FELT_CLIENT.lock().expect("Could not lock mutex");
            trace!("firefox_connect_to_felt(): connected, storing client");
            *state = Some(client);
            trace!("firefox_connect_to_felt() done: success");
            true
        }
        Err(()) => {
            trace!("firefox_connect_to_felt(): error");
            false
        }
    }
}

#[no_mangle]
pub extern "C" fn firefox_felt_connection_start_thread() {
    let guard = FELT_CLIENT.lock().expect("Could not get lock");
    match &*guard {
        Some(client) => {
            trace!("firefox_connect_to_felt(): connected, starting thread");
            client.start_thread();
        }
        None => {
            trace!("firefox_connect_to_felt(): error");
        }
    }
    trace!("firefox_connect_to_felt() done");
}

#[no_mangle]
pub extern "C" fn firefox_felt_is_startup_complete() -> bool {
    let guard = FELT_CLIENT.lock().expect("Could not get lock");
    match &*guard {
        Some(client) => client.is_startup_complete(),
        None => {
            trace!("firefox_felt_is_startup_complete(): missing client, blocking startup");
            false
        }
    }
}

/// Remove the persisted console URL from felt.json, keeping the other keys.
/// Returns true when the value is gone (including when it was never there);
/// false when the file could not be read or updated, so the stale URL may
/// still be picked up.
#[no_mangle]
pub extern "C" fn firefox_felt_clear_stored_console_url(path: &nsstring::nsACString) -> bool {
    let path = path.to_utf8();
    let bytes = match std::fs::read(&*path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
        Err(e) => {
            log::warn!("could not read {path} to clear the stored console URL: {e}");
            return false;
        }
    };
    use enterprise_console::RemoveStoredAddress;
    match enterprise_console::remove_stored_console_address(&bytes) {
        RemoveStoredAddress::AlreadyAbsent => true,
        RemoveStoredAddress::Invalid => {
            log::warn!("cannot clear the stored console URL: {path} is not a JSON object");
            false
        }
        RemoveStoredAddress::Removed(json) => match std::fs::write(&*path, json) {
            Ok(()) => true,
            Err(e) => {
                log::warn!("could not write {path} to clear the stored console URL: {e}");
                false
            }
        },
    }
}

/// Extract the console address from raw AutoConfig file contents (byte shift
/// decoded, not evaluated). Backs XRE_ReadEnterpriseConsoleAddress.
#[no_mangle]
pub extern "C" fn firefox_felt_console_address_from_autoconfig(
    contents: &nsstring::nsACString,
    out_address: &mut nsstring::nsACString,
) -> bool {
    match enterprise_console::console_address_from_autoconfig(contents) {
        Some(address) => {
            out_address.assign(&address);
            true
        }
        None => false,
    }
}

/// Resolve a console address that may be the generic build placeholder, from
/// the MOZ_ENTERPRISE_CONSOLE_URL environment variable or the URL
/// persisted in felt.json at the given path. A real address is returned
/// unchanged. Returns false when the placeholder cannot be resolved; the
/// caller then shows the console setup dialog. Backs
/// XRE_ParseEnterpriseServerURL.
#[no_mangle]
pub extern "C" fn firefox_felt_resolve_console_address(
    address: &nsstring::nsACString,
    felt_json_path: &nsstring::nsACString,
    out_url: &mut nsstring::nsACString,
) -> bool {
    let path = felt_json_path.to_utf8();
    match enterprise_console::resolve_console_address(
        &address.to_utf8(),
        std::env::var(enterprise_console::CONSOLE_ADDRESS_ENV)
            .ok()
            .as_deref(),
        || std::fs::read(&*path),
    ) {
        Ok(url) => {
            out_url.assign(&url);
            true
        }
        Err(e) => {
            // A missing felt.json or one without an address is the normal
            // first-run state leading to the setup dialog; anything else
            // means a saved address exists but cannot be used.
            if e.is_expected_first_run() {
                trace!("console address placeholder not resolvable yet: {e}");
            } else {
                log::warn!("could not resolve the console address placeholder: {e}");
            }
            false
        }
    }
}

#[no_mangle]
pub extern "C" fn firefox_felt_send_felt_ready() {
    trace!("firefox_felt_send_felt_ready()");
    let guard = FELT_CLIENT.lock().expect("Could not get lock");
    match &*guard {
        Some(client) => {
            trace!("firefox_felt_send_felt_ready(): sending message");
            client.send_felt_ready();
        }
        None => {
            trace!("firefox_felt_send_felt_ready(): missing client");
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn felt_constructor(
    iid: *const xpcom::nsIID,
    result: *mut *mut xpcom::reexports::libc::c_void,
) -> nserror::nsresult {
    let is_felt_ui = crate::IS_FELT_UI.load(Ordering::Relaxed);
    let is_felt_browser = crate::IS_FELT_BROWSER.load(Ordering::Relaxed);
    let is_felt_safe_mode = crate::IS_FELT_SAFE_MODE.load(Ordering::Relaxed);
    let felt_xpcom = components::FeltXPCOM::new(is_felt_ui, is_felt_browser, is_felt_safe_mode);
    unsafe { felt_xpcom.QueryInterface(iid, result) }
}

#[unsafe(no_mangle)]
pub extern "C" fn felt_restartforced_constructor(
    iid: *const xpcom::nsIID,
    result: *mut *mut xpcom::reexports::libc::c_void,
) -> nserror::nsresult {
    let felt_restartforced = components::FeltRestartForced::new();
    unsafe { felt_restartforced.QueryInterface(iid, result) }
}
