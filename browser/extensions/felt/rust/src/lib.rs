/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
mod message;
mod utils;

use env_logger;

static IS_FELT_UI: AtomicBool = AtomicBool::new(false);
static IS_FELT_BROWSER: AtomicBool = AtomicBool::new(false);

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

    let felt_ui_requested = arg_matches("feltui") || found_felt_ui_env;
    let is_felt_browser = arg_matches("felt");

    if is_felt_browser && felt_ui_requested {
        panic!("Cannot have both -feltUI and -felt args");
    }

    let is_felt_ui = !is_felt_browser && !bypass_env;
    trace!("felt_init(): is_felt_ui={}", is_felt_ui);
    IS_FELT_UI.store(is_felt_ui, Ordering::Relaxed);

    trace!("felt_init(): is_felt_browser={}", is_felt_browser);
    IS_FELT_BROWSER.store(is_felt_browser, Ordering::Relaxed);

    trace!("felt_init() done");
}

#[no_mangle]
pub extern "C" fn is_felt_ui() -> bool {
    trace!("is_felt_ui()");
    IS_FELT_UI.load(Ordering::Relaxed)
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
pub extern "C" fn firefox_felt_connection_start_thread() -> () {
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

#[no_mangle]
pub extern "C" fn firefox_felt_send_extension_ready() -> () {
    trace!("firefox_felt_send_extension_ready()");
    let guard = FELT_CLIENT.lock().expect("Could not get lock");
    match &*guard {
        Some(client) => {
            trace!("firefox_felt_send_extension_ready(): sending message");
            client.send_extension_ready();
        }
        None => {
            trace!("firefox_felt_send_extension_ready(): missing client");
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
    let felt_xpcom = components::FeltXPCOM::new(is_felt_ui, is_felt_browser);
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
