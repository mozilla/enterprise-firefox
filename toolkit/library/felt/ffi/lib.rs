/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use log::trace;
use std::ffi::CStr;
use std::os::raw::c_char;

use felt;

use env_logger;

#[no_mangle]
pub extern "C" fn felt_init() {
    trace!("felt_init()");
    env_logger::init();
    trace!("felt_init() done");
}

#[no_mangle]
pub extern "C" fn firefox_connect_to_felt(server_name: *const c_char) -> () {
    let srv_name = unsafe { CStr::from_ptr(server_name) };
    let server_socket = String::from_utf8_lossy(srv_name.to_bytes()).to_string();
    trace!("firefox_connect_to_felt({})", server_socket);
    let th = felt::FeltClientThread::new(server_socket);
    th.start_thread();
    th.wait_for_startup_requirements();
    trace!("firefox_connect_to_felt() done");
}

#[unsafe(no_mangle)]
pub extern "C" fn felt_constructor(
    iid: *const xpcom::nsIID,
    result: *mut *mut xpcom::reexports::libc::c_void,
) -> nserror::nsresult {
    let felt_xpcom = felt::FeltXPCOM::new();
    unsafe { felt_xpcom.QueryInterface(iid, result) }
}

#[unsafe(no_mangle)]
pub extern "C" fn felt_restartforced_constructor(
    iid: *const xpcom::nsIID,
    result: *mut *mut xpcom::reexports::libc::c_void,
) -> nserror::nsresult {
    let felt_restartforced = felt::FeltRestartForced::new();
    unsafe { felt_restartforced.QueryInterface(iid, result) }
}
