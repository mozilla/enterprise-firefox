/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use cookie;
use nserror::NS_OK;
use nsstring::nsCString;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, LazyLock, RwLock};
use std::{ffi::CString, future::Future};
use time::OffsetDateTime;
use xpcom::interfaces::{nsICookie, nsICookieManager, nsIObserverService, nsIPrefBranch};
use xpcom::RefPtr;

use log::trace;

#[derive(Default, Debug, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
}

pub static TOKEN_EXPIRY_SKEW: i64 = 5 * 60;

pub static TOKENS: LazyLock<Arc<RwLock<Tokens>>> =
    LazyLock::new(|| Arc::new(RwLock::new(Default::default())));

pub fn inject_one_cookie(raw_cookie: String) {
    trace!("inject_one_cookie() raw_cookie:{:?}", raw_cookie.clone());
    match cookie::Cookie::parse(raw_cookie) {
        Ok(cookie) => {
            let cookie2 = cookie.clone();
            trace!(
                "inject_one_cookie() name:{} value:{} domain:{:?} path:{:?}",
                cookie2.name(),
                cookie2.value(),
                cookie2.domain(),
                cookie2.path()
            );
            do_main_thread("felt_inject_one_cookie", async move {
                let host: nsCString = cookie.domain().unwrap_or("").into();
                let path: nsCString = cookie.path().unwrap_or("").into();
                let name: nsCString = cookie.name().into();
                let value: nsCString = cookie.value().into();
                let expiry: i64 = if let Some(exp) = cookie.expires() {
                    exp.datetime().unwrap().unix_timestamp() * 1000
                } else {
                    0
                };
                trace!("inject_one_cookie() expiry:{:?}", expiry);

                let is_secure = cookie.secure().unwrap_or(false);
                trace!("inject_one_cookie() is_secure:{}", is_secure);

                let is_http_only = cookie.http_only().unwrap_or(false);
                trace!("inject_one_cookie() is_http_only:{}", is_http_only);

                let same_site = match cookie.same_site() {
                    Some(cookie::SameSite::Strict) => nsICookie::SAMESITE_STRICT,
                    Some(cookie::SameSite::Lax) => nsICookie::SAMESITE_LAX,
                    Some(cookie::SameSite::None) => nsICookie::SAMESITE_NONE,
                    _ => nsICookie::SAMESITE_NONE,
                }
                .try_into()
                .unwrap();
                trace!(
                    "inject_one_cookie() cookie.same_site():{:?}",
                    cookie.same_site()
                );
                trace!("inject_one_cookie() same_site:{:?}", same_site);

                let is_session = cookie
                    .expires()
                    .unwrap_or(cookie::Expiration::from(None))
                    .is_session();
                trace!("inject_one_cookie() is_session:{}", is_session);

                let cookie_manager =
                    xpcom::get_service::<nsICookieManager>(cstr!("@mozilla.org/cookiemanager;1"))
                        .unwrap();
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
                        cookie.name()
                    );
                } else {
                    trace!(
                        "inject_one_cookie() AddNativeForFelt({}) FAILED: {}",
                        cookie.name(),
                        rv
                    );
                }
            });
        }
        Err(err) => {
            trace!("inject_one_cookie(): PARSE ERROR: {}", err);
        }
    }
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

pub fn open_url_in_firefox(url: String) {
    trace!("open_url_in_firefox() url: {}", url);
    do_main_thread("felt_open_url", async move {
        let obssvc: RefPtr<nsIObserverService> = xpcom::components::Observer::service().unwrap();
        let topic = CString::new("felt-open-url").unwrap();
        let url_data = nsstring::nsString::from(&url);

        let rv = unsafe {
            obssvc.NotifyObservers(
                std::ptr::null(),
                topic.as_ptr(),
                url_data.as_ptr(),
            )
        };

        if rv.succeeded() {
            trace!("open_url_in_firefox() successfully sent observer notification for URL: {}", url);
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
pub fn nsICookie_to_Cookie(cookie: &RefPtr<nsICookie>) -> cookie::Cookie<'_> {
    let mut name = nsCString::new();
    unsafe {
        cookie.GetName(&mut *name);
    }

    let mut value = nsCString::new();
    unsafe {
        cookie.GetValue(&mut *value);
    }

    let mut rv = cookie::Cookie::new(name.to_string(), value.to_string());
    trace!("cookie_to_string: {}", rv.name());

    let mut domain = nsCString::new();
    unsafe {
        cookie.GetHost(&mut *domain);
    }
    rv.set_domain(domain.to_string());

    let mut is_session: bool = false;
    unsafe {
        cookie.GetIsSession(&mut is_session);
    }

    let expiration = if is_session {
        None
    } else {
        let mut expiry: i64 = 0;
        unsafe {
            cookie.GetExpiry(&mut expiry);
        }
        Some(OffsetDateTime::from_unix_timestamp(expiry / 1000).unwrap())
    };
    rv.set_expires(expiration);

    let mut http_only: bool = false;
    unsafe {
        cookie.GetIsHttpOnly(&mut http_only);
    }
    rv.set_http_only(http_only);

    // rv.set_partitioned(); // needs newer version of cookie crate

    let mut path = nsCString::new();
    unsafe {
        cookie.GetPath(&mut *path);
    }
    rv.set_path(path.to_string());

    let mut same_site: i32 = 42;
    unsafe {
        cookie.GetSameSite(&mut same_site);
    }

    let val_same_site = match same_site as u32 {
        nsICookie::SAMESITE_STRICT => Some(cookie::SameSite::Strict),
        nsICookie::SAMESITE_LAX => Some(cookie::SameSite::Lax),
        nsICookie::SAMESITE_NONE => Some(cookie::SameSite::None),
        nsICookie::SAMESITE_UNSET => None,
        _ => None,
    };

    rv.set_same_site(val_same_site);

    let mut is_secure: bool = false;
    unsafe {
        cookie.GetIsSecure(&mut is_secure);
    }
    rv.set_secure(is_secure);

    rv
}
