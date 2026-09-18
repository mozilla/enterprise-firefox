/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
use nserror::{
    nsresult, NS_ERROR_CONNECTION_REFUSED, NS_ERROR_FAILURE, NS_ERROR_NOT_CONNECTED,
    NS_ERROR_PORT_ACCESS_NOT_ALLOWED, NS_ERROR_UNEXPECTED, NS_OK,
};
use nsstring::{nsACString, nsAString, nsCString, nsString};
use std::cell::RefCell;
use std::env;
use std::ffi::{c_char, CStr, CString};
use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc};
use thin_vec::ThinVec;
use time::UtcDateTime;
use xpcom::interfaces::{
    nsICategoryManager, nsIContentPolicy, nsICookie, nsILoadInfo, nsIObserver, nsIObserverService,
    nsISupports, nsIURI,
};
use xpcom::{xpcom_method, RefPtr};

use log::{error, trace, warn};

use crate::message::FeltMessage;
#[cfg(target_os = "linux")]
use crate::utils;
use crate::utils::{Tokens, CONSOLE_URL, TOKENS, TOKEN_EXPIRY_SKEW};

#[xpcom(implement(nsIFelt), atomic)]
pub struct FeltXPCOM {
    one_shot_server: RefCell<
        Option<ipc_channel::ipc::IpcOneShotServer<ipc_channel::ipc::IpcSender<FeltMessage>>>,
    >,
    tx: RefCell<Option<ipc_channel::ipc::IpcSender<FeltMessage>>>,
    rx: RefCell<Option<ipc_channel::ipc::IpcReceiver<FeltMessage>>>,
    is_felt_ui: bool,
    is_felt_browser: bool,
    is_felt_safe_mode: bool,
}

/// Whether the connecting peer's process id equals the pid of the process felt
/// expects to run as the browser. An unavailable peer pid means the transport
/// could not report one (BSD/illumos or the in-process transport), which is a
/// rejection (fail-closed). Not compiled on macOS, whose Mach back-end never
/// reports a peer pid, so it is not left as dead code there.
#[cfg(not(target_os = "macos"))]
fn peer_pid_matches(peer_pid: Option<u32>, expected_pid: u32) -> bool {
    matches!(peer_pid, Some(peer) if peer == expected_pid)
}

/// The authorization decision for a connecting peer, made from its OS process id
/// alone and independently of the protocol-version handshake, so identity and
/// protocol are not conflated.
///
/// macOS has no in-band pid attestation: its Mach back-end's peer_pid() returns
/// None, so authorization passes here and the version handshake is the only
/// in-band check. Protection on macOS is an OS property -- an unrelated process
/// cannot resolve the Mach endpoint (bootstrap_look_up returns
/// BOOTSTRAP_UNKNOWN_SERVICE) -- not something this code enforces.
#[cfg(target_os = "macos")]
fn peer_is_authorized(_peer_pid: Option<u32>, _expected_pid: u32) -> bool {
    true
}

/// Everywhere else the peer's pid must equal the expected pid: the process felt
/// spawned, or on Windows the browser child the launcher process creates and
/// announces to felt (see FeltProcessParent). A None peer pid fails closed.
#[cfg(not(target_os = "macos"))]
fn peer_is_authorized(peer_pid: Option<u32>, expected_pid: u32) -> bool {
    peer_pid_matches(peer_pid, expected_pid)
}

#[allow(non_snake_case)]
impl FeltXPCOM {
    pub fn new(
        _is_felt_ui: bool,
        _is_felt_browser: bool,
        _is_felt_safe_mode: bool,
    ) -> RefPtr<FeltXPCOM> {
        FeltXPCOM::allocate(InitFeltXPCOM {
            one_shot_server: RefCell::new(None),
            tx: RefCell::new(None),
            rx: RefCell::new(None),
            is_felt_ui: _is_felt_ui,
            is_felt_browser: _is_felt_browser,
            is_felt_safe_mode: _is_felt_safe_mode,
        })
    }

    fn send(&self, msg: FeltMessage) -> nserror::nsresult {
        trace!("FeltXPCOM:SendMessage: {:?}", msg);
        if let Some(tx) = self.tx.borrow_mut().as_mut() {
            trace!("FeltXPCOM:SendMessage: acquired tx");
            match tx.send(msg) {
                Ok(_) => {
                    trace!("FeltXPCOM:SendMessage: message sent");
                    NS_OK
                }
                Err(err) => {
                    error!("FeltXPCOM:SendMessage: error: {}", err);
                    NS_ERROR_CONNECTION_REFUSED
                }
            }
        } else {
            NS_ERROR_NOT_CONNECTED
        }
    }

    xpcom_method!(send_cookies => SendCookies(cookies: *const ThinVec<Option<RefPtr<nsICookie>>>));
    fn send_cookies(
        &self,
        cookies: &ThinVec<Option<RefPtr<nsICookie>>>,
    ) -> Result<(), nserror::nsresult> {
        let mut rv = Ok(());

        trace!("FeltXPCOM:SendCookies processing {}", cookies.len());
        if cookies.is_empty() {
            return rv;
        }

        cookies.iter().flatten().for_each(|x| {
            let cookie = crate::utils::nsICookie_wrap(x);
            trace!("FeltXPCOM::SendCookies: oneCookie: {}", cookie.name);
            let r = self.send(FeltMessage::Cookie(cookie.clone()));
            if r.failed() {
                rv = Err(r);
            }
            trace!(
                "FeltXPCOM::SendCookies: oneCookie: {} => {:?}",
                cookie.name,
                rv
            );
        });

        rv
    }

    xpcom_method!(send_bool_preference => SendBoolPreference(
        name: *const nsACString,
        value: bool
    ));
    fn send_bool_preference(
        &self,
        name: &nsACString,
        value: bool,
    ) -> Result<(), nserror::nsresult> {
        let name = name.to_string();
        trace!("FeltXPCOM::SendBoolPreference: {}", name);
        self.send(FeltMessage::BoolPreference((name, value)))
            .to_result()
    }

    xpcom_method!(send_string_preference => SendStringPreference(
        name: *const nsACString,
        value: *const nsACString
    ));
    fn send_string_preference(
        &self,
        name: &nsACString,
        value: &nsACString,
    ) -> Result<(), nserror::nsresult> {
        let name = name.to_string();
        let value = value.to_string();
        trace!("FeltXPCOM::SendStringPreference: {}", name);
        self.send(FeltMessage::StringPreference((name, value)))
            .to_result()
    }

    xpcom_method!(send_int_preference => SendIntPreference(
        name: *const nsACString,
        value: i32
    ));
    fn send_int_preference(&self, name: &nsACString, value: i32) -> Result<(), nserror::nsresult> {
        let name = name.to_string();
        trace!("FeltXPCOM::SendIntPreference: {}", name);
        self.send(FeltMessage::IntPreference((name, value)))
            .to_result()
    }

    fn SendReady(&self) -> nserror::nsresult {
        self.send(FeltMessage::StartupReady)
    }

    fn SendRestartForced(&self) -> nserror::nsresult {
        self.send(FeltMessage::RestartForced)
    }

    fn SendUpdateReady(&self) -> nserror::nsresult {
        self.send(FeltMessage::UpdateReady)
    }

    /**
     * Sends the current access token to the browser.
     * Sending from the Browser to FELT is not supported.
     */
    fn SendAccessToken(&self) -> nserror::nsresult {
        trace!("FeltXPCOM::SendAccessToken(): sending tokens");
        if self.is_felt_browser {
            trace!("FeltXPCOM::SendAccessToken(): Called from the browser, which is not supported");
            NS_OK
        } else {
            match TOKENS.read() {
                Ok(tokens) => {
                    trace!("FeltXPCOM::SendAccessToken(): performing send");
                    self.send(FeltMessage::AccessToken((
                        tokens.access_token.clone(),
                        tokens.expires_at,
                    )))
                }
                Err(_) => {
                    trace!("FeltXPCOM::SendAccessToken failed: couldn't acquire lock",);
                    NS_ERROR_FAILURE
                }
            }
        }
    }

    fn set_tokens_impl(
        &self,
        access_token: String,
        refresh_token: String,
        expires_at: i64,
    ) -> nserror::nsresult {
        match TOKENS.write() {
            Ok(mut t) => {
                *t = Tokens {
                    access_token,
                    refresh_token,
                    expires_at,
                };
                trace!(
                    "FeltXPCOM::set_tokens_impl(): successfull set of token, expires_at={}",
                    expires_at
                );
                NS_OK
            }
            Err(_) => {
                trace!(
                    "FeltXPCOM::set_tokens_impl(): failure while setting tokens, expires_at={}",
                    expires_at
                );
                NS_ERROR_FAILURE
            }
        }
    }

    xpcom_method!(set_tokens => SetTokens(
        access_token: *const nsACString,
        refresh_token: *const nsACString,
        expires_at: i64
    ));
    fn set_tokens(
        &self,
        access_token: &nsACString,
        refresh_token: &nsACString,
        expires_at: i64,
    ) -> Result<(), nserror::nsresult> {
        trace!(
            "FeltXPCOM::SetTokens(): setting tokens, expires_at={}",
            expires_at
        );
        self.set_tokens_impl(
            access_token.to_string(),
            refresh_token.to_string(),
            expires_at,
        )
        .to_result()
    }

    // This clears access and refresh tokens only in the current process, i.e. there is
    // no propagation of the cleared tokens to other processes.
    fn ClearTokens(&self) -> nserror::nsresult {
        trace!("FeltXPCOM::ClearTokens(): clearing");
        self.set_tokens_impl("".to_string(), "".to_string(), 0)
    }

    // Send the console-supplied primarySecret to the spawned Firefox over the
    // existing Felt IPC channel. Called from the Felt UI process right after
    // spawning Firefox; the secret is never stored on either side -- the UI
    // fetches it and relays it here, and the browser hands it straight to the
    // storage encryption layer on receipt (see client.rs). No-op if invoked
    // from the browser side. Mirrors SendAccessToken.
    xpcom_method!(send_primary_secret => SendPrimarySecret(
        hex: *const nsACString
    ));
    fn send_primary_secret(&self, hex: &nsACString) -> Result<(), nserror::nsresult> {
        if self.is_felt_browser {
            // SendPrimarySecret must only be invoked from the Felt UI process
            // (which relays the secret to the spawned browser); reaching here
            // from the browser side is a programming error, so surface it.
            error!("FeltXPCOM::SendPrimarySecret: called from the browser side");
            return Err(NS_ERROR_UNEXPECTED);
        }
        let hex = hex.to_string();
        if hex.is_empty() {
            trace!("FeltXPCOM::SendPrimarySecret: empty primarySecret, not sending");
            return Err(NS_ERROR_FAILURE);
        }
        self.send(FeltMessage::PrimarySecret(hex)).to_result()
    }

    fn RequestUpdateCheck(&self) -> nserror::nsresult {
        trace!("FeltXPCOM::RequestUpdateCheck()");
        let guard = crate::FELT_CLIENT.lock().expect("Could not get lock");
        match &*guard {
            Some(client) => client.request_update_check(),
            None => NS_ERROR_NOT_CONNECTED,
        }
    }

    fn RefreshTokens(&self) -> nserror::nsresult {
        trace!("FeltXPCOM::RefreshTokens");
        let guard = crate::FELT_CLIENT.lock().expect("Could not get lock");
        match &*guard {
            Some(client) => {
                trace!("RefreshTokens(): calling client.notify_refresh_tokens()");
                client.notify_refresh_tokens();
                NS_OK
            }
            None => {
                trace!("firefox_felt_refresh_tokens(): missing client");
                NS_ERROR_FAILURE
            }
        }
    }

    xpcom_method!(get_refresh_token => GetRefreshToken() -> nsACString);
    fn get_refresh_token(&self) -> Result<nsCString, nserror::nsresult> {
        let t = TOKENS.read().map_err(|_| NS_ERROR_FAILURE)?;
        Ok(nsCString::from(t.refresh_token.as_str()))
    }

    xpcom_method!(get_access_token_if_valid => GetAccessTokenIfValid() -> nsACString);
    fn get_access_token_if_valid(&self) -> Result<nsCString, nserror::nsresult> {
        let t = TOKENS.read().map_err(|_| NS_ERROR_FAILURE)?;
        let token = if token_needs_refresh(&t) {
            ""
        } else {
            t.access_token.as_str()
        };
        Ok(nsCString::from(token))
    }

    fn SendFeltReady(&self) -> nserror::nsresult {
        trace!("FeltXPCOM::SendFeltReady");
        if self.is_felt_browser {
            trace!("FeltXPCOM::SendFeltReady: calling firefox_felt_send_felt_ready");
            crate::firefox_felt_send_felt_ready();
            NS_OK
        } else {
            trace!("FeltXPCOM::SendFeltReady: not in browser, ignoring");
            NS_OK
        }
    }

    xpcom_method!(open_url => OpenURL(url: *const nsACString, disposition: i32));
    fn open_url(&self, url: &nsACString, disposition: i32) -> Result<(), nserror::nsresult> {
        let url = url.to_string();
        #[cfg(target_os = "linux")]
        let focus_hint = utils::get_focus_hint();
        #[cfg(not(target_os = "linux"))]
        let focus_hint = None;
        trace!(
            "FeltXPCOM::OpenURL: {} {} {:?}",
            url,
            disposition,
            focus_hint
        );
        self.send(FeltMessage::OpenURL((url, disposition, focus_hint)))
            .to_result()
    }

    xpcom_method!(get_console_url => GetConsoleUrl() -> nsACString);
    fn get_console_url(&self) -> Result<nsCString, nserror::nsresult> {
        CONSOLE_URL
            .get()
            .ok_or_else(|| {
                trace!("FeltXPCOM::GetConsoleUrl called before initialized");
                NS_ERROR_FAILURE
            })
            .map(|url| nsCString::from(url.as_str()))
    }

    fn ShutdownFirefox(&self) -> nserror::nsresult {
        if self.is_felt_ui {
            trace!("FeltXPCOM::ShutdownFirefox");
            self.send(FeltMessage::Shutdown)
        } else {
            error!("ShutdownFirefox called from browser, which is not allowed");
            NS_ERROR_FAILURE
        }
    }

    fn PerformSignout(&self) -> nserror::nsresult {
        trace!("FeltXPCOM::PerformSignout");
        let guard = crate::FELT_CLIENT.lock().expect("Could not get lock");
        match &*guard {
            Some(client) => {
                client.notify_signout();
                NS_OK
            }
            None => {
                trace!("performSignout(): missing client");
                NS_ERROR_FAILURE
            }
        }
    }

    xpcom_method!(ipc_channel => IpcChannel(pid: u32));
    fn ipc_channel(&self, expected_pid: u32) -> Result<(), nserror::nsresult> {
        let felt_server = match self.one_shot_server.take() {
            Some(f) => f,
            None => {
                return Err(NS_ERROR_FAILURE);
            }
        };

        trace!("FeltXPCOM:IpcChannel() waiting on accept()");
        let (pending_authentication_rx, tx): (_, ipc_channel::ipc::IpcSender<FeltMessage>) =
            felt_server.accept().unwrap();

        // Identify the connecting peer by the OS process id of the just accepted
        // connection, so the peer can be matched against the browser child the
        // launcher spawned before any managed secret is sent. The accept
        // receiver is not used past this point, so drop it once queried.
        let peer_pid = pending_authentication_rx.peer_pid();
        drop(pending_authentication_rx);

        // AUTHORIZATION: decided from the peer's pid alone, before the version
        // handshake below, and kept separate from it. On attested platforms any
        // other same-user process that races to connect has a different pid (or
        // none) and is refused here, so it never receives the primarySecret,
        // tokens, prefs, or cookies the launcher sends afterwards over `self.tx`.
        let authorized = peer_is_authorized(peer_pid, expected_pid);
        if !authorized {
            match peer_pid {
                None => warn!(
                    "FeltXPCOM:IpcChannel() refused IPC peer: transport reported no peer pid (no attestation)"
                ),
                Some(pid) => warn!(
                    "FeltXPCOM:IpcChannel() refused IPC peer: pid {} does not match expected {}",
                    pid, expected_pid
                ),
            }
            return Err(NS_ERROR_PORT_ACCESS_NOT_ALLOWED);
        }

        // The peer is authorized. Hand it the sender it uses to talk back to
        // felt and retain both ends; the managed secrets are sent afterwards
        // over `self.tx`.
        let (tx_firefox_to_felt, rx): (
            ipc_channel::ipc::IpcSender<FeltMessage>,
            ipc_channel::ipc::IpcReceiver<FeltMessage>,
        ) = ipc_channel::ipc::channel().unwrap();
        if let Err(err) = tx.send(FeltMessage::ClientChannel(tx_firefox_to_felt)) {
            trace!("FeltXPCOM:IpcChannel() failed to send ClientChannel: {}", err);
            return Err(NS_ERROR_FAILURE);
        }

        trace!("FeltXPCOM:IpcChannel() peer authenticated");
        self.tx.replace(Some(tx));
        self.rx.replace(Some(rx));

        if let Ok(thread) = moz_task::create_thread("felt_server").map_err(|_| {
            trace!("FeltServerThread::start_thread(): felt_server thread error");
        }) {
            let rx_clone = self.rx.take();
            let _ = moz_task::RunnableBuilder::new("felt_server::ipc_loop", move || {
                trace!("FeltServerThread::start_thread(): felt_server thread runnable");
                if let Some(rx) = rx_clone {
                    loop {
                        match rx.recv() {
                            Ok(FeltMessage::Restarting) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): Restarting");
                                crate::utils::notify_observers("felt-firefox-restarting".to_string());
                            },
                            Ok(FeltMessage::Exiting) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): Exiting");
                                crate::utils::notify_observers("felt-firefox-exiting".to_string());
                            },
                            Ok(FeltMessage::FeltReady) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): FeltReady");
                                crate::utils::notify_observers("felt-ready".to_string());
                            },
                            Ok(FeltMessage::LogoutShutdown) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): Shutdown for logout");
                                crate::utils::notify_observers("felt-firefox-logout".to_string());
                            }
                            Ok(FeltMessage::AccessToken((access_token, expires_at))) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): Update tokens from browser");
                                let payload = serde_json::json!({
                                    "access_token": access_token,
                                    "expires_at": expires_at,
                                }).to_string();
                                crate::utils::notify_observers_with_payload("felt-firefox-tokens".to_string(), Some(payload));
                            },
                            Ok(FeltMessage::CheckForUpdates) => {
                                crate::utils::notify_observers("felt-firefox-check-for-updates".to_string());
                            },
                            Ok(FeltMessage::RefreshTokens) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): Browser is requesting token refresh");
                                crate::utils::notify_observers("felt-firefox-refresh-tokens".to_string());
                            },
                            Err(ipc_channel::IpcError::Disconnected) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): DISCONNECTED");
                                break;
                            },
                            Err(ipc_channel::IpcError::SerializationError(deserializeErr)) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): IPC DESERIALIZE ERROR {:?}", deserializeErr);
                            },
                            Err(ipc_channel::IpcError::Io(ioErr)) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): IPC I/O ERROR {:?}", ioErr);
                            },
                            Ok(msg) => {
                                trace!("FeltServerThread::felt_server::ipc_loop(): UNEXPECTED MSG {:?}", msg);
                            },
                        }
                    }
                    trace!("FeltServerThread::felt_server::ipc_loop(): DONE");
                }
                trace!("FeltServerThread::felt_server::ipc_loop(): THREAD END");
            })
            .may_block(true)
            .dispatch(&thread);

            Ok(())
        } else {
            Err(NS_ERROR_FAILURE)
        }
    }

    xpcom_method!(bin_path => BinPath() -> nsAString);
    fn bin_path(&self) -> Result<nsString, nserror::nsresult> {
        match env::current_exe() {
            Ok(exe_path) => {
                // Use separate code path between Windows and others platforms
                // here because on Windows it is already encoded as wide strings
                #[cfg(windows)]
                let wide: Vec<u16> = {
                    use std::os::windows::ffi::OsStrExt;
                    exe_path.as_os_str().encode_wide().collect()
                };

                #[cfg(not(windows))]
                let wide: Vec<u16> = match exe_path.to_str() {
                    Some(path) => path.encode_utf16().collect(),
                    None => {
                        trace!("FeltXPCOM: BinPath: to_str() failure");
                        return Err(NS_ERROR_FAILURE);
                    }
                };

                Ok(nsString::from(&wide[..]))
            }
            Err(err) => {
                trace!("FeltXPCOM: BinPath: err={}", err);
                Err(NS_ERROR_FAILURE)
            }
        }
    }

    // Transforms the browser application to a "background application",
    // i.e. no menu bar, and no dock icon. Or the other way round,
    // depending on the `background` parameter.
    xpcom_method!(make_background_process => MakeBackgroundProcess(background: bool) -> bool);
    #[allow(unused_variables)]
    fn make_background_process(&self, background: bool) -> Result<bool, nserror::nsresult> {
        trace!("FeltXPCOM: MakeBackgroundProcess");
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
            return Ok(rv == 0);
        }

        #[cfg(not(target_os = "macos"))]
        {
            trace!("FeltXPCOM: MakeBackgroundProcess: no call done");
            Ok(false)
        }
    }

    xpcom_method!(is_felt_ui => IsFeltUI() -> bool);
    fn is_felt_ui(&self) -> Result<bool, nserror::nsresult> {
        trace!("FeltXPCOM: IsFeltUI: {}", self.is_felt_ui);
        Ok(self.is_felt_ui)
    }

    xpcom_method!(is_felt_browser => IsFeltBrowser() -> bool);
    fn is_felt_browser(&self) -> Result<bool, nserror::nsresult> {
        trace!("FeltXPCOM: IsFeltBrowser: {}", self.is_felt_browser);
        Ok(self.is_felt_browser)
    }

    xpcom_method!(is_felt_safe_mode => IsFeltSafeMode() -> bool);
    fn is_felt_safe_mode(&self) -> Result<bool, nserror::nsresult> {
        trace!("FeltXPCOM: IsFeltSafeMode: {}", self.is_felt_safe_mode);
        Ok(self.is_felt_safe_mode)
    }

    xpcom_method!(one_shot_ipc_server => OneShotIpcServer() -> nsACString);
    fn one_shot_ipc_server(&self) -> Result<nsCString, nserror::nsresult> {
        if let Ok((felt_server, felt_server_name)) =
            ipc_channel::ipc::IpcOneShotServer::<ipc_channel::ipc::IpcSender<FeltMessage>>::new()
        {
            trace!(
                "FeltXPCOM: IpcChannel(): felt_server_name={}",
                felt_server_name
            );
            self.one_shot_server.replace(Some(felt_server));
            Ok(nsCString::from(&felt_server_name))
        } else {
            Err(NS_ERROR_FAILURE)
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

        let topic = cstr!("felt-restart-forced");
        let rv =
            unsafe { obssvc.AddObserver(xpcom.coerce::<nsIObserver>(), topic.as_ptr(), false) };
        assert!(rv.succeeded());

        trace!("FeltRestartForced:new() register with nsICategoryManager");
        let catMan: RefPtr<nsICategoryManager> =
            xpcom::components::CategoryManager::service().unwrap();

        let category = nsCString::from("felt-restart-forced");
        let contractID = nsCString::from("@mozilla-org/felt-restart-forced;1");
        let mut retval = nsCString::new();
        trace!("FeltRestartForced:new() register with nsICategoryManager: call");
        let rv = unsafe {
            catMan.AddCategoryEntry(
                &*category,
                &*contractID,
                &*contractID,
                false,
                true,
                &mut *retval,
            )
        };
        trace!(
            "FeltRestartForced:new() register with nsICategoryManager: rv={}",
            rv
        );

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
        match topic.as_ref().map(|_| CStr::from_ptr(topic).to_str()) {
            None => trace!("FeltRestartForced::observe() null topic"),
            Some(Ok("felt-restart-forced")) => {
                trace!("FeltRestartForced::observe() felt-restart-forced");
                self.restart_forced.store(true, Ordering::Relaxed);
            }
            Some(Ok(topic)) => {
                trace!("FeltRestartForced::observe() topic: {}", topic);
            }
            Some(Err(err)) => {
                trace!("FeltRestartForced::observe() err: {}", err);
            }
        }
        NS_OK
    }

    // nsIContentPolicy
    xpcom_method!(should_load => ShouldLoad(
        a_content_location: *const nsIURI,
        _a_load_info: *const nsILoadInfo
    ) -> i16);
    fn should_load(
        &self,
        a_content_location: &nsIURI,
        _a_load_info: *const nsILoadInfo,
    ) -> Result<i16, nsresult> {
        trace!("FeltRestartForced: ShouldLoad");
        Ok(self.is_restart_forced(a_content_location))
    }

    xpcom_method!(should_process => ShouldProcess(
        a_content_location: *const nsIURI,
        _a_load_info: *const nsILoadInfo
    ) -> i16);
    fn should_process(
        &self,
        a_content_location: &nsIURI,
        _a_load_info: *const nsILoadInfo,
    ) -> Result<i16, nsresult> {
        trace!("FeltXPCOM: ShouldProcess");
        Ok(self.is_restart_forced(a_content_location))
    }

    fn is_scheme(aContentLocation: &nsIURI, scheme: &str) -> bool {
        let schemeStr = CString::new(scheme).unwrap();
        let mut isScheme = false;
        unsafe {
            aContentLocation.SchemeIs(schemeStr.as_ptr(), &mut isScheme);
        }
        isScheme
    }

    fn is_restart_forced(&self, aContentLocation: &nsIURI) -> i16 {
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

#[cfg(test)]
mod tests {
    use super::*;

    // Bug 2072053: the launcher must only hand its managed secrets to the
    // browser child it spawned. On platforms that attest a peer pid, the
    // connecting peer's pid must equal the spawned child's; anything else is a
    // peer that must receive nothing. peer_pid_matches captures that core check;
    // macOS has no peer pid to match, so it and this test are gated off that
    // target.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn peer_pid_matches_only_the_spawned_child() {
        let child_pid = 4242; // stand-in for the spawned child's pid

        // The intended child: pid equals the expected pid.
        assert!(peer_pid_matches(Some(child_pid), child_pid));

        // Another same-user process that connected first: a different pid is
        // rejected.
        assert!(!peer_pid_matches(Some(child_pid + 1), child_pid));

        // The transport could not report the peer's pid: reject, fail-closed.
        assert!(!peer_pid_matches(None, child_pid));
    }

    // On attested platforms authorization requires a matching pid: a same-user
    // peer with a different pid, or a transport that reports no pid, is refused,
    // and the intended child is admitted. This includes Windows, where the
    // expected pid is the browser child the launcher process announced.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn attested_platforms_require_matching_pid() {
        let child_pid = 4242;
        assert!(peer_is_authorized(Some(child_pid), child_pid));
        assert!(!peer_is_authorized(Some(child_pid + 1), child_pid));
        assert!(!peer_is_authorized(None, child_pid));
    }

    // On macOS the transport cannot attest a peer pid, so authorization passes
    // here and the version handshake is the only in-band check. Endpoint
    // reachability is an OS property, not enforced by this code.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_authorizes_without_peer_pid() {
        let child_pid = 4242;
        assert!(peer_is_authorized(None, child_pid));
        assert!(peer_is_authorized(Some(child_pid + 1), child_pid));
    }

}
