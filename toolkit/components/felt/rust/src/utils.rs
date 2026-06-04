/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use nserror::NS_OK;
use nsstring::{nsACString, nsCString};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, LazyLock, OnceLock, RwLock};
use std::{ffi::CString, future::Future};
use xpcom::interfaces::{nsICookie, nsICookieManager, nsIObserverService, nsIPrefBranch};
use xpcom::RefPtr;

use log::trace;
#[cfg(target_os = "linux")]
use std::os::raw::c_char;

use crate::message::{nsICookieWrapper, FocusHint};

#[cfg(target_os = "linux")]
extern "C" {
    fn felt_set_startup_token_or_timestamp(token: *const c_char, timestamp: u32);
    fn felt_get_startup_token_or_timestamp(
        out_token: *mut *const c_char,
        out_token_len: *mut u32,
        out_timestamp: *mut u32,
    );
}

#[cfg(target_os = "macos")]
extern "C" {
    fn felt_activate_app();
}

extern "C" {
    // Defined in storage/SQLiteEncryption.cpp. Hands the console-supplied
    // primarySecret to the storage encryption layer; Felt keeps no copy.
    fn mozStorageSetSqlitePrimarySecret(hex: *const nsACString);
}

/// Hand the console-supplied primarySecret (64-char hex) to the storage
/// encryption layer. The value is consumed here and never retained by Felt.
pub fn moz_storage_set_sqlite_primary_secret(hex: String) {
    let hex: nsCString = hex.as_str().into();
    unsafe { mozStorageSetSqlitePrimarySecret(&*hex) };
}

#[cfg(target_os = "linux")]
pub fn get_focus_hint() -> Option<FocusHint> {
    let mut token_ptr: *const c_char = std::ptr::null();
    let mut token_len: u32 = 0;
    let mut timestamp: u32 = 0;
    unsafe {
        felt_get_startup_token_or_timestamp(&mut token_ptr, &mut token_len, &mut timestamp);
    }
    if !token_ptr.is_null() && token_len > 0 {
        let slice =
            unsafe { std::slice::from_raw_parts(token_ptr as *const u8, token_len as usize) };
        return Some(FocusHint::StartupToken(
            String::from_utf8_lossy(slice).into_owned(),
        ));
    }
    if timestamp != 0 {
        return Some(FocusHint::Timestamp(timestamp));
    }
    None
}

#[derive(Default, Debug, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
}

pub static TOKEN_EXPIRY_SKEW: i64 = 5 * 60;

pub static TOKENS: LazyLock<Arc<RwLock<Tokens>>> =
    LazyLock::new(|| Arc::new(RwLock::new(Default::default())));
pub static CONSOLE_URL: OnceLock<Arc<String>> = OnceLock::new();

pub fn inject_one_cookie(cookie: nsICookieWrapper) {
    trace!("inject_one_cookie() cookie:{:?}", cookie.clone());
    trace!(
        "inject_one_cookie() name:{} value:{} domain:{:?} path:{:?}",
        cookie.name.clone(),
        cookie.value.clone(),
        cookie.domain.clone(),
        cookie.path.clone()
    );
    do_main_thread("felt_inject_one_cookie", async move {
        let host: nsCString = cookie.domain.clone().into();
        let path: nsCString = cookie.path.clone().into();
        let name: nsCString = cookie.name.clone().into();
        let value: nsCString = cookie.value.clone().into();
        let expiry: i64 = cookie.expiration;
        trace!("inject_one_cookie() expiry:{:?}", expiry);

        let is_secure = cookie.is_secure;
        trace!("inject_one_cookie() is_secure:{}", is_secure);

        let is_http_only = cookie.http_only;
        trace!("inject_one_cookie() is_http_only:{}", is_http_only);

        let same_site = cookie.same_site;
        trace!(
            "inject_one_cookie() cookie.same_site():{:?}",
            cookie.same_site
        );
        trace!("inject_one_cookie() same_site:{:?}", same_site);

        let is_session = cookie.is_session;
        trace!("inject_one_cookie() is_session:{}", is_session);

        let cookie_manager =
            xpcom::get_service::<nsICookieManager>(cstr!("@mozilla.org/cookiemanager;1")).unwrap();
        let rv = unsafe {
            cookie_manager.AddNativeForFelt(
                &*host,
                &*path,
                &*name,
                &*value,
                is_secure,
                is_http_only,
                is_session,
                expiry,
                same_site,
                nsICookie::SCHEME_UNSET,
                false, // cookie.partitioned().unwrap(), NOT IN cookie 0.16 crate
            )
        };

        if rv == NS_OK {
            trace!(
                "inject_one_cookie() AddNativeForFelt({}) SUCCESS",
                cookie.name
            );
        } else {
            trace!(
                "inject_one_cookie() AddNativeForFelt({}) FAILED: {}",
                cookie.name,
                rv
            );
        }
    });
}

pub fn inject_bool_pref(name: String, value: bool) {
    do_main_thread("felt_inject_bool_pref", async move {
        let c_name = CString::new(name.as_str()).expect("Pref name contained a null byte");
        let prefs: RefPtr<nsIPrefBranch> = xpcom::components::Preferences::service().unwrap();
        if unsafe { prefs.SetBoolPref(c_name.as_ptr(), value) } == NS_OK {
            trace!(
                "inject_bool_pref(): BoolPreference({}, {}) NS_OK",
                name,
                value
            );
        } else {
            trace!(
                "inject_bool_pref(): BoolPreference({}, {}) ERROR",
                name,
                value
            );
        }
    });
}

pub fn inject_string_pref(name: String, value: String) {
    do_main_thread("felt_inject_string_pref", async move {
        let c_name = CString::new(name.as_str()).expect("Pref name contained a null byte");
        let c_value: nsCString = value.as_str().into();
        let prefs: RefPtr<nsIPrefBranch> = xpcom::components::Preferences::service().unwrap();
        if unsafe { prefs.SetStringPref(c_name.as_ptr(), &*c_value) } == NS_OK {
            trace!(
                "inject_string_pref(): StringPreference({}, {}) NS_OK",
                name,
                value
            );
        } else {
            trace!(
                "inject_string_pref(): StringPreference({}, {}) ERROR",
                name,
                value
            );
        }
    });
}

pub fn inject_int_pref(name: String, value: i32) {
    do_main_thread("felt_inject_int_pref", async move {
        let c_name = CString::new(name.as_str()).expect("Pref name contained a null byte");
        let prefs: RefPtr<nsIPrefBranch> = xpcom::components::Preferences::service().unwrap();
        if unsafe { prefs.SetIntPref(c_name.as_ptr(), value) } == NS_OK {
            trace!(
                "inject_int_pref(): IntPreference({}, {}) NS_OK",
                name,
                value
            );
        } else {
            trace!(
                "inject_int_pref(): IntPreference({}, {}) ERROR",
                name,
                value
            );
        }
    });
}

pub fn notify_observers_with_payload(name: String, payload: Option<String>) {
    do_main_thread("felt_notify_observers", async move {
        let obssvc: RefPtr<nsIObserverService> = xpcom::components::Observer::service().unwrap();
        let topic = CString::new(name).expect("Topic name contained a null byte");
        let rv = if let Some(data) = payload {
            let payload_data = nsstring::nsString::from(&data);
            unsafe {
                obssvc.NotifyObservers(std::ptr::null(), topic.as_ptr(), payload_data.as_ptr())
            }
        } else {
            unsafe { obssvc.NotifyObservers(std::ptr::null(), topic.as_ptr(), std::ptr::null()) }
        };
        assert!(rv.succeeded());
    });
}

pub fn notify_observers(name: String) {
    notify_observers_with_payload(name, None)
}

pub fn open_url_in_firefox(url: String, disposition: i32, focus_hint: Option<FocusHint>) {
    trace!(
        "open_url_in_firefox() url: {} disposition: {} focus_hint: {:?}",
        url,
        disposition,
        focus_hint
    );
    do_main_thread("felt_activate_for_url", async move {
        #[cfg(target_os = "linux")]
        if let Some(ref hint) = focus_hint {
            match hint {
                FocusHint::StartupToken(token) => {
                    if let Ok(c_token) = CString::new(token.as_str()) {
                        unsafe {
                            felt_set_startup_token_or_timestamp(c_token.as_ptr(), 0);
                        }
                    }
                }
                FocusHint::Timestamp(ts) => unsafe {
                    felt_set_startup_token_or_timestamp(std::ptr::null(), *ts);
                },
            }
        }
        // Widget interaction needs to be on the main thread.
        #[cfg(target_os = "macos")]
        unsafe {
            felt_activate_app();
        }
    });
    let payload = serde_json::json!({
        "url": url,
        "disposition": disposition,
    })
    .to_string();
    notify_observers_with_payload("felt-open-url".to_string(), Some(payload));
}

pub fn do_main_thread<F>(name: &'static str, future: F)
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    if let Ok(main_thread) = moz_task::get_main_thread() {
        trace!("FeltThread::do_main_thread() {}", name);
        moz_task::spawn_onto(name, main_thread.coerce(), future).detach();
    }
}

#[allow(non_snake_case)]
pub fn nsICookie_wrap(cookie: &RefPtr<nsICookie>) -> nsICookieWrapper {
    let mut name = nsCString::new();
    unsafe {
        cookie.GetName(&mut *name);
    }

    let mut value = nsCString::new();
    unsafe {
        cookie.GetValue(&mut *value);
    }

    let mut domain = nsCString::new();
    unsafe {
        cookie.GetHost(&mut *domain);
    }

    let mut is_session: bool = false;
    unsafe {
        cookie.GetIsSession(&mut is_session);
    }

    let mut expiration: i64 = 0;
    unsafe {
        cookie.GetExpiry(&mut expiration);
    }

    let mut http_only: bool = false;
    unsafe {
        cookie.GetIsHttpOnly(&mut http_only);
    }

    // rv.set_partitioned(); // needs newer version of cookie crate

    let mut path = nsCString::new();
    unsafe {
        cookie.GetPath(&mut *path);
    }

    let mut same_site: i32 = 42;
    unsafe {
        cookie.GetSameSite(&mut same_site);
    }

    let mut is_secure: bool = false;
    unsafe {
        cookie.GetIsSecure(&mut is_secure);
    }

    trace!("nsICookie_wrap: {}", name.to_string());

    nsICookieWrapper::new(
        name.to_string(),
        value.to_string(),
        domain.to_string(),
        is_session,
        expiration,
        http_only,
        path.to_string(),
        same_site,
        is_secure,
    )
}

pub fn set_console_url(console_url: String) {
    let console_url = Arc::new(console_url);
    match CONSOLE_URL.set(console_url) {
        Ok(()) => {
            trace!(
                "set_console_url: console_url set to {}",
                CONSOLE_URL.get().map_or("<unset>", |v| v)
            );
        }
        Err(console_url) => {
            trace!(
                "set_console_url: failed to set console_url to {} (current url: {})",
                console_url,
                CONSOLE_URL.get().map_or("<unset>", |v| v)
            );
        }
    }
}
