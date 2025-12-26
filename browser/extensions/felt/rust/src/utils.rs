/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use nserror::NS_OK;
use nsstring::nsCString;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, LazyLock, OnceLock, RwLock};
use std::{ffi::CString, future::Future};
use xpcom::interfaces::{nsICookie, nsICookieManager, nsIObserverService, nsIPrefBranch};
use xpcom::RefPtr;

use log::trace;

use crate::message::nsICookieWrapper;

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

pub fn notify_observers(name: String) {
    do_main_thread("felt_notify_observers", async move {
        let obssvc: RefPtr<nsIObserverService> = xpcom::components::Observer::service().unwrap();
        let topic = CString::new(name).expect("Topic name contained a null byte");
        let rv =
            unsafe { obssvc.NotifyObservers(std::ptr::null(), topic.as_ptr(), std::ptr::null()) };
        assert!(rv.succeeded());
    });
}

pub fn open_url_in_firefox(url: String, disposition: i32) {
    trace!(
        "open_url_in_firefox() url: {} disposition: {}",
        url,
        disposition
    );
    let payload = json!({
        "url": url,
        "disposition": disposition,
    })
    .to_string();
    do_main_thread("felt_open_url", async move {
        let obssvc: RefPtr<nsIObserverService> = xpcom::components::Observer::service().unwrap();
        let topic = CString::new("felt-open-url").unwrap();
        let url_data = nsstring::nsString::from(&payload);

        let rv =
            unsafe { obssvc.NotifyObservers(std::ptr::null(), topic.as_ptr(), url_data.as_ptr()) };

        if rv.succeeded() {
            trace!(
                "open_url_in_firefox() successfully sent observer notification for URL request"
            );
        } else {
            trace!("open_url_in_firefox() NotifyObservers failed: {:?}", rv);
        }
    });
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
