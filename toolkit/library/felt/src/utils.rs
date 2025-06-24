/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use cookie;
use std::ffi::CString;
use nserror::NS_OK;
use nsstring::nsCString;
use xpcom::interfaces::{nsICookie, nsICookieManager, nsIPrefBranch, nsIObserverService};
use xpcom::RefPtr;
use time::OffsetDateTime;

use log::trace;

pub fn inject_one_cookie(raw_cookie: String) {
    match cookie::Cookie::parse(raw_cookie) {
        Ok(cookie) => {
            let cookie2 = cookie.clone();
            let cookie_name = cookie2.name();
            trace!("inject_one_cookie() name:{}", cookie_name);
            do_main_thread("felt_inject_one_cookie", async move {

                let host: nsCString = cookie.domain().unwrap().into();
                let path: nsCString = cookie.path().unwrap().into();
                let name: nsCString = cookie.name().into();
                let value: nsCString = cookie.value().into();
                let expiry: i64 = cookie
                    .expires()
                    .unwrap()
                    .datetime()
                    .unwrap()
                    .unix_timestamp()
                    * 1000;

                let cookie_manager = xpcom::get_service::<nsICookieManager>(cstr!("@mozilla.org/cookiemanager;1")).unwrap();

                unsafe {
                    cookie_manager.AddNativeForFelt(
                        &*host,
                        &*path,
                        &*name,
                        &*value,
                        cookie.secure().unwrap_or(false),
                        cookie.http_only().unwrap_or(false),
                        cookie.expires().unwrap().is_session(),
                        expiry,
                        match cookie.same_site() {
                            Some(cookie::SameSite::Strict) => nsICookie::SAMESITE_STRICT,
                            Some(cookie::SameSite::Lax) => nsICookie::SAMESITE_LAX,
                            Some(cookie::SameSite::None) => nsICookie::SAMESITE_NONE,
                            _ => nsICookie::SAMESITE_NONE,
                        }
                        .try_into()
                        .unwrap(),
                        nsICookie::SCHEME_UNSET,
                        false, // cookie.partitioned().unwrap(), NOT IN cookie 0.16 crate
                    )
                };
            });
        }
        Err(err) => {
            trace!("FeltThread::felt_client::ipc_loop() PARSE ERROR: {}", err);
        }
    }
}

pub fn inject_bool_pref(name: String, value: bool) {
    do_main_thread("felt_inject_bool_pref", async move {
        let c_name = CString::new(name.clone()).unwrap().into_raw();
        let prefs: RefPtr<nsIPrefBranch> = xpcom::components::Preferences::service().unwrap();
        if unsafe { prefs.SetBoolPref(c_name, value) } == NS_OK {
            trace!("inject_bool_pref(): BoolPreference({}, {}) NS_OK", name, value);
        } else {
            trace!("inject_bool_pref(): BoolPreference({}, {}) ERROR", name, value);
        }
    });
}

pub fn inject_string_pref(name: String, value: String) {
    do_main_thread("felt_inject_string_pref", async move {
        let c_name = CString::new(name.clone()).unwrap().into_raw();
        let c_value: nsCString = value.clone().into();
        let prefs: RefPtr<nsIPrefBranch> = xpcom::components::Preferences::service().unwrap();
        if unsafe { prefs.SetStringPref(c_name, &*c_value) } == NS_OK {
            trace!("inject_string_pref(): StringPreference({}, {}) NS_OK", name, value);
        } else {
            trace!("inject_string_pref(): StringPreference({}, {}) ERROR", name, value);
        }
    });
}

pub fn notify_observers(name: String) {
    do_main_thread("felt_notify_observers", async move {
        let obssvc: RefPtr<nsIObserverService> =
            xpcom::components::Observer::service().unwrap();
        let topic = CString::new(name.clone()).unwrap().into_raw();
        let rv = unsafe { obssvc.NotifyObservers(std::ptr::null(), topic, std::ptr::null()) };
        assert!(rv.succeeded());
    });
}

fn do_main_thread<F>(name: &'static str, future: F)
where F: Future + Send + 'static,
      F::Output: Send + 'static,
{
    if let Ok(main_thread) = moz_task::get_main_thread() {
        trace!("FeltThread::do_main_thread() {}", name);
        moz_task::spawn_onto(name, main_thread.coerce(), future).detach();
    }
}

#[allow(non_snake_case)]
pub fn nsICookie_to_Cookie(cookie: &RefPtr<nsICookie>) -> cookie::Cookie {
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

    let same_site: u32 = nsICookie::SAMESITE_UNSET;
    unsafe {
        cookie.GetSameSite(&mut (same_site as i32));
    }

    let val_same_site = match same_site {
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
