/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use ipc_channel;

use nserror::{nsresult, NS_ERROR_FAILURE, NS_OK};
use nsstring::{nsACString, nsCString};
use std::cell::RefCell;
use std::env;
use std::ffi::{c_char, CStr, CString};
use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc};
use std::time::Duration;
use thin_vec::ThinVec;
use time::UtcDateTime;
use xpcom::interfaces::{
    nsICategoryManager, nsIContentPolicy, nsICookie, nsILoadInfo, nsIObserver, nsIObserverService,
    nsISupports, nsIURI,
};
use xpcom::RefPtr;

use log::trace;

use crate::message::{FeltMessage, FELT_IPC_VERSION};
use crate::utils::{Tokens, TOKENS, TOKEN_EXPIRY_SKEW};

#[xpcom(implement(nsIFelt), atomic)]
pub struct FeltXPCOM {
    one_shot_server: RefCell<
        Option<ipc_channel::ipc::IpcOneShotServer<ipc_channel::ipc::IpcSender<FeltMessage>>>,
    >,
    tx: RefCell<Option<ipc_channel::ipc::IpcSender<FeltMessage>>>,
    rx: RefCell<Option<ipc_channel::ipc::IpcReceiver<FeltMessage>>>,
    is_felt_ui: bool,
    is_felt_browser: bool,
}

#[allow(non_snake_case)]
impl FeltXPCOM {
    pub fn new(_is_felt_ui: bool, _is_felt_browser: bool) -> RefPtr<FeltXPCOM> {
        FeltXPCOM::allocate(InitFeltXPCOM {
            one_shot_server: RefCell::new(None),
            tx: RefCell::new(None),
            rx: RefCell::new(None),
            is_felt_ui: _is_felt_ui,
            is_felt_browser: _is_felt_browser,
        })
    }

    fn send(&self, msg: FeltMessage) -> nserror::nsresult {
        trace!("FeltXPCOM:SendMessage: {:?}", msg);
        if let Some(tx) = self.tx.borrow_mut().as_mut() {
            trace!("FeltXPCOM:SendMessage: acquired tx");
            tx.send(msg).unwrap();
            trace!("FeltXPCOM:SendMessage: message sent");
            NS_OK
        } else {
            NS_ERROR_FAILURE
        }
    }

    fn SendCookies(&self, cookies: *const ThinVec<Option<RefPtr<nsICookie>>>) -> nserror::nsresult {
        let mut rv = NS_ERROR_FAILURE;
        let cookies = unsafe { &*cookies };
        trace!("FeltXPCOM:SendCookies processing {}", cookies.len());
        if cookies.len() == 0 {
            return NS_OK;
        }

        cookies.iter().flatten().for_each(|x| {
            trace!("FeltXPCOM::SendCookies: oneCookie ....");
            let cookie = crate::utils::nsICookie_to_Cookie(x);
            trace!("FeltXPCOM::SendCookies: oneCookie: {}", cookie.name());
            rv = self.send(FeltMessage::Cookie(cookie.to_string()));
        });

        rv
    }

    fn SendBoolPreference(&self, name: *const nsACString, value: bool) -> nserror::nsresult {
        let name_s = unsafe { (*name).to_string() };
        trace!("FeltXPCOM::SendBoolPreference: {}", name_s);
        self.send(FeltMessage::BoolPreference((name_s, value)))
    }

    fn SendStringPreference(
        &self,
        name: *const nsACString,
        value: *const nsACString,
    ) -> nserror::nsresult {
        let name_s = unsafe { (*name).to_string() };
        let value_s = unsafe { (*value).to_string() };
        trace!("FeltXPCOM::SendStringPreference: {}", name_s);
        self.send(FeltMessage::StringPreference((name_s, value_s)))
    }

    fn SendIntPreference(&self, name: *const nsACString, value: i32) -> nserror::nsresult {
        let name_s = unsafe { (*name).to_string() };
        trace!("FeltXPCOM::SendIntPreference: {}", name_s);
        self.send(FeltMessage::IntPreference((name_s, value)))
    }

    fn SendReady(&self) -> nserror::nsresult {
        self.send(FeltMessage::StartupReady)
    }

    fn SendRestartForced(&self) -> nserror::nsresult {
        self.send(FeltMessage::RestartForced)
    }

    fn SendTokens(&self) -> nserror::nsresult {
        match TOKENS.read() {
            Ok(tokens) => {
                trace!(
                    "FeltXPCOM::SendTokens ({} {} {})",
                    tokens.access_token,
                    tokens.refresh_token,
                    tokens.expires_at
                );
                self.send(FeltMessage::Tokens((
                    tokens.access_token.clone(),
                    tokens.refresh_token.clone(),
                    tokens.expires_at,
                )))
            }
            Err(_) => {
                trace!("FeltXPCOM::SendTokens failed: couldn't acquire lock",);
                NS_ERROR_FAILURE
            }
        }
    }

    fn SetTokens(
        &self,
        access_token: *const nsACString,
        refresh_token: *const nsACString,
        expires_in: i64,
    ) -> nserror::nsresult {
        let access_token = unsafe { (*access_token).to_string() };
        let refresh_token = unsafe { (*refresh_token).to_string() };
        let expires_at = UtcDateTime::now()
            .unix_timestamp()
            .saturating_add(expires_in);
        match TOKENS.write() {
            Ok(mut t) => {
                *t = Tokens {
                    access_token,
                    refresh_token,
                    expires_at,
                };
                NS_OK
            }
            Err(_) => NS_ERROR_FAILURE,
        }
    }

    fn GetRefreshToken(&self, refresh_token: *mut nsACString) -> nserror::nsresult {
        match TOKENS.read() {
            Ok(t) => unsafe {
                (*refresh_token).assign(t.refresh_token.as_str());
                NS_OK
            },
            Err(_) => NS_ERROR_FAILURE,
        }
    }

    fn GetAccessTokenIfValid(&self, access_token: *mut nsACString) -> nserror::nsresult {
        match TOKENS.read() {
            Ok(t) => unsafe {
                (*access_token).assign(if token_needs_refresh(&t) {
                    ""
                } else {
                    t.access_token.as_str()
                });
                NS_OK
            },
            Err(_) => NS_ERROR_FAILURE,
        }
    }

    fn SendExtensionReady(&self) -> nserror::nsresult {
        trace!("FeltXPCOM::SendExtensionReady");
        if self.is_felt_browser {
            trace!("FeltXPCOM::SendExtensionReady: calling firefox_felt_send_extension_ready");
            crate::firefox_felt_send_extension_ready();
            NS_OK
        } else {
            trace!("FeltXPCOM::SendExtensionReady: not in browser, ignoring");
            NS_OK
        }
    }

    fn OpenURL(&self, url: *const nsACString) -> nserror::nsresult {
        let url_s = unsafe { (*url).to_string() };
        trace!("FeltXPCOM::OpenURL: {}", url_s);
        self.send(FeltMessage::OpenURL(url_s))
    }

    // Firefox to FELT to notify of logout
    fn PerformSignout(&self) -> nserror::nsresult {
        trace!("FeltXPCOM::PerformSignout");
        let guard = crate::FELT_CLIENT.lock().expect("Could not get lock");
        match &*guard {
            Some(client) => {
                trace!("firefox_felt_send_extension_ready(): sending message");
                client.notify_signout();
            }
            None => {
                trace!("firefox_felt_send_extension_ready(): missing client");
            }
        }
        NS_OK
    }

    fn IpcChannel(&self) -> nserror::nsresult {
        let felt_server = match self.one_shot_server.take() {
            Some(f) => f,
            None => {
                return NS_ERROR_FAILURE;
            }
        };

        trace!("FeltXPCOM:IpcChannel() waiting on accept()");
        let (_, tx): (_, ipc_channel::ipc::IpcSender<FeltMessage>) = felt_server.accept().unwrap();

        let (tx_firefox_to_felt, rx): (
            ipc_channel::ipc::IpcSender<FeltMessage>,
            ipc_channel::ipc::IpcReceiver<FeltMessage>,
        ) = ipc_channel::ipc::channel().unwrap();
        match tx.send(FeltMessage::ClientChannel(tx_firefox_to_felt)) {
            Ok(()) => {
                trace!("FeltXPCOM:YOUPI");
            }
            Err(err) => {
                trace!("FeltXPCOM:ERROR tx0.send() {}", err);
            }
        }

        let versions_match = match rx.recv() {
            Ok(FeltMessage::VersionProbe(version)) => version == FELT_IPC_VERSION,
            Ok(msg) => {
                trace!("FeltXPCOM:rx.recv() INVALID MSG {:?}", msg);
                false
            }
            Err(err) => {
                trace!("FeltXPCOM:rx.recv() ERR {}", err);
                false
            }
        };

        if versions_match {
            trace!("FeltXPCOM:YOUPI SAME VERSION");
        } else {
            trace!("FeltXPCOM:SAD NOT SAME VERSION");
        }

        match tx.send(FeltMessage::VersionValidated(versions_match)) {
            Ok(()) => {
                trace!(
                    "FeltXPCOM:tx.send(FeltMessage::VersionValidated({})) OK",
                    versions_match
                );
                self.tx.replace(Some(tx));
                self.rx.replace(Some(rx));
            }
            Err(err) => {
                trace!(
                    "FeltXPCOM:tx.send(FeltMessage::VersionValidated({})) err={}",
                    versions_match,
                    err
                );

                return NS_ERROR_FAILURE;
            }
        };

        if let Ok(thread) = moz_task::create_thread("felt_server").map_err(|_| {
            trace!("FeltServerThread::start_thread(): felt_server thread error");
        }) {
            let rx_clone = self.rx.take();
            let _ = moz_task::RunnableBuilder::new("felt_server::ipc_loop", move || {
                trace!("FeltServerThread::start_thread(): felt_server thread runnable");
                if let Some(rx) = rx_clone {
                    loop {
                        match rx.try_recv_timeout(Duration::from_millis(250)) {
                            Ok(FeltMessage::Restarting) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): Restarting");
                                crate::utils::notify_observers("felt-firefox-restarting".to_string());
                            },
                            Ok(FeltMessage::ExtensionReady) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): ExtensionReady");
                                crate::utils::notify_observers("felt-extension-ready".to_string());
                            },
                            Ok(FeltMessage::LogoutShutdown) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): Shutdown for logout");
                                crate::utils::notify_observers("felt-firefox-logout".to_string());
                            },
                            Ok(msg) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): UNEXPECTED MSG {:?}", msg);
                            },
                            Err(ipc_channel::ipc::TryRecvError::IpcError(ipc_channel::ipc::IpcError::Disconnected)) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): DISCONNECTED");
                                break;
                            },
                            Err(ipc_channel::ipc::TryRecvError::IpcError(err)) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): TryRecvError: {}", err);
                            },
                            Err(ipc_channel::ipc::TryRecvError::Empty) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): NO DATA.");
                            },
                        }
                    }
                    trace!("FeltServerThread::felt_server::ipc_loop(): DONE");
                }
                trace!("FeltServerThread::felt_server::ipc_loop(): THREAD END");
            })
            .may_block(true)
            .dispatch(&thread);

            NS_OK
        } else {
            NS_ERROR_FAILURE
        }
    }

    fn BinPath(&self, bin: *mut nsACString) -> nserror::nsresult {
        match env::current_exe() {
            Ok(exe_path) => match exe_path.to_str() {
                Some(path) => {
                    unsafe {
                        (*bin).assign(path);
                    }
                    NS_OK
                }
                None => {
                    trace!("FeltXPCOM: BinPath: to_str() failure");
                    NS_ERROR_FAILURE
                }
            },
            Err(err) => {
                trace!("FeltXPCOM: BinPath: err={}", err);
                NS_ERROR_FAILURE
            }
        }
    }

    #[allow(unused_variables)]
    fn MakeBackgroundProcess(&self, background: bool, success: *mut bool) -> nserror::nsresult {
        trace!("FeltXPCOM: MakeBackgroundProcess");
        unsafe {
            *success = false;
        }
        #[cfg(target_os = "macos")]
        {
            #[repr(C)]
            struct ProcessSerialNumber {
                pub highLongOfPSN: u32,
                pub lowLongOfPSN: u32,
            }

            type ProcessApplicationTransformState = u32;
            let kProcessTransformToForegroundApplication = 1;
            let kProcessTransformToBackgroundApplication = 2;
            let kCurrentProcess = 2;

            unsafe extern "C-unwind" {
                fn TransformProcessType(
                    psn: *const ProcessSerialNumber,
                    transform_state: ProcessApplicationTransformState,
                ) -> u32;
            }

            let psn = ProcessSerialNumber {
                highLongOfPSN: 0,
                lowLongOfPSN: kCurrentProcess,
            };
            let rv = unsafe {
                TransformProcessType(
                    &psn,
                    if background {
                        kProcessTransformToBackgroundApplication
                    } else {
                        kProcessTransformToForegroundApplication
                    },
                )
            };
            trace!("FeltXPCOM: MakeBackgroundProcess: rv={:?}", rv);

            unsafe {
                *success = rv == 0;
            }
        }

        trace!("FeltXPCOM: MakeBackgroundProcess: {}", unsafe { *success });
        NS_OK
    }

    fn IsFeltUI(&self, is_felt_ui: *mut bool) -> nserror::nsresult {
        trace!("FeltXPCOM: IsFeltUI");
        unsafe {
            *is_felt_ui = self.is_felt_ui;
        }
        trace!("FeltXPCOM: IsFeltUI: {}", self.is_felt_ui);
        NS_OK
    }

    fn IsFeltBrowser(&self, is_felt_browser: *mut bool) -> nserror::nsresult {
        trace!("FeltXPCOM: IsFeltBrowser");
        unsafe {
            *is_felt_browser = self.is_felt_browser;
        }
        trace!("FeltXPCOM: IsFeltBrowser: {}", self.is_felt_browser);
        NS_OK
    }

    fn OneShotIpcServer(&self, channel: *mut nsACString) -> nserror::nsresult {
        if let Ok((felt_server, felt_server_name)) =
            ipc_channel::ipc::IpcOneShotServer::<ipc_channel::ipc::IpcSender<FeltMessage>>::new()
        {
            trace!(
                "FeltXPCOM: IpcChannel(): felt_server_name={}",
                felt_server_name
            );
            unsafe {
                (*channel).assign(&felt_server_name);
            }
            self.one_shot_server.replace(Some(felt_server));
            NS_OK
        } else {
            NS_ERROR_FAILURE
        }
    }
}

#[xpcom(implement(nsIFeltRestartForced, nsIObserver), atomic)]
pub struct FeltRestartForced {
    restart_forced: Arc<AtomicBool>,
}

#[allow(non_snake_case)]
impl FeltRestartForced {
    pub fn new() -> RefPtr<FeltRestartForced> {
        let obssvc: RefPtr<nsIObserverService> = xpcom::components::Observer::service().unwrap();

        let restart_forced_control = Arc::new(AtomicBool::new(false));
        let xpcom = FeltRestartForced::allocate(InitFeltRestartForced {
            restart_forced: restart_forced_control.clone(),
        });

        let topic = CString::new("felt-restart-forced").unwrap();
        let rv =
            unsafe { obssvc.AddObserver(xpcom.coerce::<nsIObserver>(), topic.as_ptr(), false) };
        assert!(rv.succeeded());

        trace!("FeltRestartForced:new() register with nsICategoryManager");
        let catMan: RefPtr<nsICategoryManager> =
            xpcom::components::CategoryManager::service().unwrap();

        unsafe {
            let mut category = nsCString::new();
            (*category).assign("felt-restart-forced");
            let mut contractID = nsCString::new();
            (*contractID).assign("@mozilla-org/felt-restart-forced;1");
            let mut retval = nsCString::new();
            trace!(
                "FeltRestartForced:new() register with nsICategoryManager: call in unsafe block"
            );
            let rv = catMan.AddCategoryEntry(
                &*category,
                &*contractID,
                &*contractID,
                false,
                true,
                &mut *retval,
            );
            trace!(
                "FeltRestartForced:new() register with nsICategoryManager: rv={}",
                rv
            );
        }

        xpcom
    }

    // nsIObserver

    #[allow(non_snake_case)]
    unsafe fn Observe(
        &self,
        _subject: *const nsISupports,
        topic: *const c_char,
        _data: *const u16,
    ) -> nsresult {
        match unsafe { CStr::from_ptr(topic).to_str() } {
            Ok("felt-restart-forced") => {
                trace!("FeltRestartForced::observe() felt-restart-forced");
                self.restart_forced.store(true, Ordering::Relaxed);
            }
            Ok(topic) => {
                trace!("FeltRestartForced::observe() topic: {}", topic);
            }
            Err(err) => {
                trace!("FeltRestartForced::observe() err: {}", err);
            }
        }
        NS_OK
    }

    // nsIContentPolicy

    fn ShouldLoad(
        &self,
        aContentLocation: *const nsIURI,
        _aLoadInfo: *const nsILoadInfo,
        retval: *mut i16,
    ) -> ::nserror::nsresult {
        trace!("FeltRestartForced: ShouldLoad");
        unsafe {
            *retval = self.is_restart_forced(aContentLocation);
        }
        NS_OK
    }

    fn ShouldProcess(
        &self,
        aContentLocation: *const nsIURI,
        _aLoadInfo: *const nsILoadInfo,
        retval: *mut i16,
    ) -> ::nserror::nsresult {
        trace!("FeltXPCOM: ShouldProcess");
        unsafe {
            *retval = self.is_restart_forced(aContentLocation);
        }
        NS_OK
    }

    fn is_scheme(aContentLocation: *const nsIURI, scheme: &str) -> bool {
        let schemeStr = CString::new(scheme).unwrap();
        let mut isScheme = false;
        unsafe {
            (*aContentLocation).SchemeIs(schemeStr.as_ptr(), &mut isScheme);
        }
        isScheme
    }

    fn is_restart_forced(&self, aContentLocation: *const nsIURI) -> i16 {
        let isHttp = Self::is_scheme(aContentLocation, "http");
        let isHttps = Self::is_scheme(aContentLocation, "https");

        if (isHttp || isHttps) && self.restart_forced.load(Ordering::Relaxed) {
            nsIContentPolicy::REJECT_RESTARTFORCED
        } else {
            nsIContentPolicy::ACCEPT
        }
    }
}

fn token_needs_refresh(tokens: &Tokens) -> bool {
    tokens.expires_at.saturating_add(TOKEN_EXPIRY_SKEW) < UtcDateTime::now().unix_timestamp()
}
