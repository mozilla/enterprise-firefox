/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
#![allow(clippy::not_unsafe_ptr_arg_deref)]

use log::trace;
use std::sync::atomic::AtomicBool;
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
use std::ffi::CStr;
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
use std::os::raw::c_char;

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
mod disk_encryption;
#[cfg(target_os = "linux")]
mod disk_encryption_linux;
#[cfg(target_os = "macos")]
mod disk_encryption_macos;
#[cfg(target_os = "windows")]
mod disk_encryption_win;
mod message;
mod process;
mod utils;

pub use utils::{CONSOLE_URL, TOKENS};

static IS_FELT_UI: AtomicBool = AtomicBool::new(false);
static IS_FELT_BROWSER: AtomicBool = AtomicBool::new(false);
static IS_FELT_SAFE_MODE: AtomicBool = AtomicBool::new(false);

/// Env var carrying the inherited bootstrap-endpoint fd on the Linux fenced-fd
/// path. Set by FeltProcessParent on the spawned browser; its presence also
/// marks the process as the felt browser (replacing the `-felt <name>` argv).
#[cfg(target_os = "linux")]
const FELT_IPC_FD_ENV: &str = "MOZ_FELT_IPC_FD";
/// Env var carrying the value of the inherited bootstrap-endpoint pipe HANDLE on
/// the Windows fenced-handle path. Set by FeltProcessParent on the spawned
/// launcher and inherited transitively by the browser child; its presence also
/// marks the process as the felt browser (replacing the `-felt <name>` argv).
#[cfg(target_os = "windows")]
const FELT_IPC_HANDLE_ENV: &str = "MOZ_FELT_IPC_HANDLE";

#[cfg(target_os = "linux")]
type FeltIpcEndpoint = std::os::unix::io::RawFd;
#[cfg(target_os = "windows")]
type FeltIpcEndpoint = usize;

/// The inherited bootstrap endpoint, parsed from its env var by felt_init.
/// None if the var was present but did not hold a usable value.
#[cfg(any(target_os = "linux", target_os = "windows"))]
static FELT_IPC_ENDPOINT: std::sync::OnceLock<Option<FeltIpcEndpoint>> =
    std::sync::OnceLock::new();

/// Parses and removes the inherited-endpoint env var, so that processes this
/// browser spawns (background tasks, restarts) do not inherit it and mistake
/// themselves for the felt browser. Returns whether the var was present.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn take_felt_ipc_endpoint() -> bool {
    #[cfg(target_os = "linux")]
    let name = FELT_IPC_FD_ENV;
    #[cfg(target_os = "windows")]
    let name = FELT_IPC_HANDLE_ENV;
    let Some(value) = env::var_os(name) else {
        return false;
    };
    env::remove_var(name);
    let parsed = value
        .to_str()
        .and_then(|v| v.parse::<FeltIpcEndpoint>().ok());
    #[cfg(target_os = "linux")]
    let endpoint = parsed.filter(|fd| *fd >= 0);
    #[cfg(target_os = "windows")]
    let endpoint = parsed.filter(|handle| *handle != 0);
    let _ = FELT_IPC_ENDPOINT.set(endpoint);
    true
}
// Whether a browser shutdown locks the session instead of signing out.
pub(crate) static SHUTDOWN_LOCK_INTENT: AtomicBool = AtomicBool::new(false);
// Whether a browser restart locks the session instead of signing out.
pub(crate) static RESTART_LOCK_INTENT: AtomicBool = AtomicBool::new(false);

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

/// MOZ_BYPASS_FELT starts the browser UI without Felt, which is only ever
/// wanted for local development and automation. Restrict it to builds that
/// cannot ship to users, i.e. those with the "default" channel a plain
/// mozconfig produces.
fn bypass_allowed() -> bool {
    matches!(mozbuild::config::MOZ_UPDATE_CHANNEL, "default")
}

#[no_mangle]
pub extern "C" fn felt_init() {
    trace!("felt_init()");
    env_logger::init();

    let found_felt_ui_env = has_env("MOZ_FELT_UI");
    let bypass_env = has_env("MOZ_BYPASS_FELT") && bypass_allowed();
    trace!("felt_init(): bypass_env={}", bypass_env);

    // There may be a -chrome ... being passed on the CLI, e.g. for jsdebugger
    // in this case, it is not expected the FELT UI is shown, not the browser UI
    let force_chrome = arg_matches("chrome");
    trace!("felt_init(): force_chrome={}", force_chrome);

    let felt_ui_requested = arg_matches("feltui") || found_felt_ui_env;

    // On Linux/Windows the fenced bootstrap replaces the `-felt <name>` argv: the
    // spawned browser is marked by the inherited-endpoint env var instead. macOS
    // still uses the argv marker.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let is_felt_browser = take_felt_ipc_endpoint() && !force_chrome;
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
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

fn store_felt_client(client: client::FeltClientThread) -> bool {
    let mut state = FELT_CLIENT.lock().expect("Could not lock mutex");
    trace!("store_felt_client(): connected, storing client");
    *state = Some(client);
    true
}

// macOS: connect to the published one-shot server by name.
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
#[no_mangle]
pub extern "C" fn firefox_connect_to_felt(server_name: *const c_char) -> bool {
    let srv_name = unsafe { CStr::from_ptr(server_name) };
    let server_socket = String::from_utf8_lossy(srv_name.to_bytes()).to_string();
    trace!("firefox_connect_to_felt({})", server_socket);
    match client::FeltClientThread::new(server_socket) {
        Ok(client) => store_felt_client(client),
        Err(()) => {
            trace!("firefox_connect_to_felt(): error");
            false
        }
    }
}

// Linux fenced-fd path: reconstruct the bootstrap endpoint from the fd inherited
// from the Felt process, named in the MOZ_FELT_IPC_FD env var.
#[cfg(target_os = "linux")]
#[no_mangle]
pub extern "C" fn firefox_connect_to_felt_fd() -> bool {
    let fd = match FELT_IPC_ENDPOINT.get().copied().flatten() {
        Some(fd) => fd,
        None => {
            log::error!("firefox_connect_to_felt_fd(): missing/invalid {FELT_IPC_FD_ENV}");
            return false;
        }
    };
    trace!("firefox_connect_to_felt_fd({fd})");
    match client::FeltClientThread::new_from_fd(fd) {
        Ok(client) => store_felt_client(client),
        Err(()) => {
            log::error!("firefox_connect_to_felt_fd(): failed to connect over fd {fd}");
            false
        }
    }
}

// Windows fenced-handle path: reconstruct the bootstrap endpoint from the pipe
// HANDLE inherited through the launcher, its value named in the
// MOZ_FELT_IPC_HANDLE env var.
#[cfg(target_os = "windows")]
#[no_mangle]
pub extern "C" fn firefox_connect_to_felt_handle() -> bool {
    let handle = match FELT_IPC_ENDPOINT.get().copied().flatten() {
        Some(handle) => handle,
        None => {
            log::error!("firefox_connect_to_felt_handle(): missing/invalid {FELT_IPC_HANDLE_ENV}");
            return false;
        }
    };
    trace!("firefox_connect_to_felt_handle({handle})");
    match client::FeltClientThread::new_from_handle(handle) {
        Ok(client) => store_felt_client(client),
        Err(()) => {
            log::error!("firefox_connect_to_felt_handle(): failed to connect over handle {handle}");
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
