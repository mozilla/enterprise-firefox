/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use ipc_channel;

#[macro_use]
extern crate cstr;
#[macro_use]
extern crate xpcom;
extern crate thin_vec;

use nserror::{NS_ERROR_FAILURE, NS_OK, nsresult};
use nsstring::{nsACString, nsCString, nsString};
use std::cell::RefCell;
use std::env;
use std::ffi::{CStr, CString, c_char};
use std::sync::{Arc, atomic::AtomicBool, atomic::Ordering};
use std::sync::{LazyLock, RwLock};
use std::time::Duration;
use thin_vec::ThinVec;
use xpcom::RefPtr;
use xpcom::interfaces::{
    nsICategoryManager, nsIContentPolicy, nsICookie, nsILoadInfo, nsIObserver, nsIObserverService,
    nsISupports, nsIURI,
};

use log::trace;

mod utils;

mod message;
use crate::message::{FELT_IPC_VERSION, FeltMessage};

#[derive(Default)]
pub struct Tokens {
    access_token: String,
    refresh_token: String,
}

pub static IS_FELT_UI: AtomicBool = AtomicBool::new(false);
pub static IS_FELT_BROWSER: AtomicBool = AtomicBool::new(false);
pub static REFRESH_TOKEN: LazyLock<Arc<RwLock<Tokens>>> =
    LazyLock::new(|| Arc::new(RwLock::new(Default::default())));

#[derive(Default)]
pub struct FeltIpcClient {
    tx: Option<ipc_channel::ipc::IpcSender<FeltMessage>>,
    rx: Option<ipc_channel::ipc::IpcReceiver<FeltMessage>>,
}

impl FeltIpcClient {
    pub fn new(felt_server_name: String) -> Self {
        trace!("FeltIpcClient::new({})", felt_server_name);

        let (tx_felt_to_firefox, rx_firefox_to_felt): (
            ipc_channel::ipc::IpcSender<FeltMessage>,
            ipc_channel::ipc::IpcReceiver<FeltMessage>,
        ) = ipc_channel::ipc::channel().unwrap();
        match ipc_channel::ipc::IpcSender::connect(felt_server_name) {
            Ok(tx0) => {
                trace!("FeltIpcClient::new() connected!");

                match tx0.send(tx_felt_to_firefox) {
                    Ok(()) => trace!("FeltIpcClient::new() tx0.send(tx_felt_to_firefox) SENT"),
                    Err(err) => trace!("FeltIpcClient::new() ERROR: {}", err),
                }

                match rx_firefox_to_felt.recv() {
                    Ok(msg) => match msg {
                        FeltMessage::ClientChannel(tx_firefox_to_felt) => {
                            trace!("FeltIpcClient::new() rx_firefox_to_felt.recv() OK");
                            Self {
                                tx: Some(tx_firefox_to_felt),
                                rx: Some(rx_firefox_to_felt),
                            }
                        }
                        _ => {
                            trace!("FeltIpcClient::new() unexpected message");
                            Self { tx: None, rx: None }
                        }
                    },
                    Err(err) => {
                        trace!("FeltIpcClient::new() rx_firefox_to_felt.recv() ERR {}", err);
                        Self { tx: None, rx: None }
                    }
                }
            }
            Err(err) => {
                trace!("FeltIpcClient::new() failed: {}", err);
                Self { tx: None, rx: None }
            }
        }
    }

    pub fn notify_restart(&self) {
        trace!("FeltIpcClient::notify_restart()");
        let msg = FeltMessage::Restarting;
        if let Some(tx) = &self.tx {
            match tx.send(msg) {
                Ok(()) => trace!("FeltIpcClient::notify_restart() SENT"),
                Err(err) => trace!("FeltIpcClient::notify_restart() TX ERROR: {}", err),
            }
        }
    }

    pub fn report_version(&self) -> bool {
        trace!("FeltIpcClient::report_version()");
        let msg = FeltMessage::VersionProbe(FELT_IPC_VERSION);
        if let Some(tx) = &self.tx {
            match tx.send(msg) {
                Ok(()) => trace!("FeltIpcClient::report_version() SENT"),
                Err(err) => trace!("FeltIpcClient::report_version() TX ERROR: {}", err),
            }
        }

        if let Some(rx) = &self.rx {
            match rx.recv() {
                Ok(FeltMessage::VersionValidated(true)) => {
                    trace!("FeltIpcClient::report_version() VALIDATED");
                    true
                }
                Ok(FeltMessage::VersionValidated(false)) => {
                    trace!("FeltIpcClient::report_version() REJRECTED");
                    false
                }
                Ok(_) => {
                    trace!("FeltIpcClient::report_version() UNEXPECTED MSG");
                    false
                }
                Err(err) => {
                    trace!("FeltIpcClient::report_version() RX ERROR: {}", err);
                    false
                }
            }
        } else {
            trace!("FeltIpcClient::report_version() RX MISSING?");
            false
        }
    }
}

pub struct FeltClientThread {
    ipc_client: RefCell<FeltIpcClient>,
    startup_ready: Arc<AtomicBool>,
}

impl FeltClientThread {
    pub fn new(felt_server_name: String) -> Result<Self, ()> {
        trace!(
            "FeltClientThread::new(): connecting to {}",
            felt_server_name.clone()
        );
        let felt_client = FeltIpcClient::new(felt_server_name);
        if felt_client.report_version() {
            Ok(Self {
                ipc_client: RefCell::new(felt_client),
                startup_ready: Arc::new(AtomicBool::new(false)),
            })
        } else {
            trace!("FeltClientThread::new(): failure to report version");
            Err(())
        }
    }

    pub fn start_thread(&self) -> nserror::nsresult {
        trace!("FeltClientThread::start_thread()");
        trace!("FeltClientThread::start_thread(): creating thread");
        let Ok(thread) = moz_task::create_thread("felt_client") else {
            trace!("FeltClientThread::start_thread(): felt_client thread error");
            return NS_ERROR_FAILURE;
        };
        trace!("FeltClientThread::start_thread(): created thread");

        // Define an observer
        #[xpcom(implement(nsIObserver), nonatomic)]
        struct Observer {
            thread_stop: Arc<AtomicBool>,
            notify_restart: Arc<AtomicBool>,
        }

        impl Observer {
            #[allow(non_snake_case)]
            unsafe fn Observe(
                &self,
                _subject: *const nsISupports,
                topic: *const c_char,
                data: *const u16,
            ) -> nsresult {
                match unsafe { CStr::from_ptr(topic).to_str() } {
                    Ok("xpcom-shutdown-threads") => {
                        trace!("FeltClientThread::start_thread::observe() xpcom-shutdown-threads");
                        self.thread_stop.store(true, Ordering::Relaxed);
                    }
                    Ok("quit-application") => {
                        trace!("FeltClientThread::start_thread::observe() quit-application");
                        // notification is sent from https://searchfox.org/firefox-main/rev/856a307913c2b73765b4e88d32cf15ed05549cae/toolkit/components/startup/nsAppStartup.cpp#494
                        let len = unsafe {
                            let mut data_len = 0;
                            let mut ptr: *const u16 = data;
                            while ptr != std::ptr::null() && *ptr != 0x0000 {
                                ptr = ptr.wrapping_offset(1);
                                data_len += 1;
                            }
                            data_len
                        };
                        trace!(
                            "FeltClientThread::start_thread::observe() quit-application: len={}",
                            len
                        );
                        let text = unsafe { std::slice::from_raw_parts(data, len) };
                        let obsData = nsString::from(text).to_string();
                        trace!(
                            "FeltClientThread::start_thread::observe() quit-application: data={}",
                            obsData
                        );
                        match obsData.trim() {
                            "restart" => {
                                trace!(
                                    "FeltClientThread::start_thread::observe() quit-application: restart"
                                );
                                self.notify_restart.store(true, Ordering::Relaxed);
                            }
                            _ => {
                                trace!(
                                    "FeltClientThread::start_thread::observe() quit-application: something else? Ignore"
                                );
                            }
                        }
                    }
                    Ok(topic) => {
                        trace!("FeltClientThread::start_thread::observe() topic: {}", topic);
                    }
                    Err(err) => {
                        trace!("FeltClientThread::start_thread::observe() err: {}", err);
                    }
                }
                NS_OK
            }
        }

        trace!("FeltClientThread::start_thread(): get observer service");
        let obssvc: RefPtr<nsIObserverService> = xpcom::components::Observer::service().unwrap();

        let xpcom_shutdown = CString::new("xpcom-shutdown-threads").unwrap();
        let quit_application = CString::new("quit-application").unwrap();

        let thread_stop = Arc::new(AtomicBool::new(false));
        let notify_restart = Arc::new(AtomicBool::new(false));
        let observer = Observer::allocate(InitObserver {
            thread_stop: thread_stop.clone(),
            notify_restart: notify_restart.clone(),
        });
        let mut rv = unsafe {
            obssvc.AddObserver(
                observer.coerce::<nsIObserver>(),
                xpcom_shutdown.as_ptr(),
                false,
            )
        };
        assert!(rv.succeeded());
        trace!("FeltClientThread::start_thread(): added observers");

        rv = unsafe {
            obssvc.AddObserver(
                observer.coerce::<nsIObserver>(),
                quit_application.as_ptr(),
                false,
            )
        };
        assert!(rv.succeeded());

        let barrier = self.startup_ready.clone();
        let thread_stop_internal = thread_stop.clone();
        let notify_restart_internal = notify_restart.clone();
        let mut felt_client = self.ipc_client.take();
        trace!("FeltClientThread::start_thread(): started thread: build runnable");
        let _ = moz_task::RunnableBuilder::new("felt_client::ipc_loop", move || {
            trace!("FeltClientThread::start_thread(): felt_client thread runnable");
                trace!("FeltClientThread::start_thread(): felt_client version OK");
                if let Some(rx) = felt_client.rx.take() {
                    loop {
                        if notify_restart_internal.load(Ordering::Relaxed) {
                            notify_restart_internal.store(false, Ordering::Relaxed);
                            trace!("FeltClientThread::felt_client::ipc_loop(): restart notification required!");
                            felt_client.notify_restart();
                        }

                        match rx.try_recv_timeout(Duration::from_millis(250)) {
                            Ok(FeltMessage::Cookie(felt_cookie)) => {
                                trace!("FeltClientThread::felt_client::ipc_loop(): received cookie: {}", felt_cookie.clone());
                                utils::inject_one_cookie(felt_cookie);
                            },
                            Ok(FeltMessage::BoolPreference((name, value))) => {
                                trace!("FeltClientThread::felt_client::ipc_loop(): BoolPreference({}, {})", name, value);
                                utils::inject_bool_pref(name, value);
                            },
                            Ok(FeltMessage::StringPreference((name, value))) => {
                                if name == "enterprise.console.refresh_token" {
                                    if let Ok(mut token) = REFRESH_TOKEN.write() {
                                        *token = Tokens { access_token: String::new(), refresh_token: value };
                                        trace!("FeltClientThread::felt_client::ipc_loop(): RefreshToken({})", token.refresh_token);
                                    } else {
                                        trace!("FeltClientThread::felt_client::ipc_loop(): ERROR setting RefreshToken({})", value);
                                    }
                                } else {
                                    trace!("FeltClientThread::felt_client::ipc_loop(): StringPreference({}, {})", name, value);
                                    utils::inject_string_pref(name, value);
                                }
                            },
                            Ok(FeltMessage::IntPreference((name, value))) => {
                                trace!("FeltClientThread::felt_client::ipc_loop(): IntPreference({}, {})", name, value);
                                utils::inject_int_pref(name, value);
                            },
                            Ok(FeltMessage::StartupReady) => {
                                trace!("FeltClientThread::felt_client::ipc_loop(): StartupReady");
                                let barrier = barrier.clone();
                                // We spawn this onto the main thread to ensure that any other tasks spawned to the main thread
                                // previously (e.g. setting preferences) are completed before we set the startup_ready flag.
                                utils::do_main_thread("felt_notify_observers", async move {
                                    barrier.store(true, Ordering::Release);
                                });
                                trace!("FeltClientThread::felt_client::ipc_loop(): StartupReady: unblocking");
                            },
                            Ok(FeltMessage::RestartForced) => {
                                trace!("FeltClientThread::felt_client::ipc_loop(): RestartForced");
                                utils::notify_observers("felt-restart-forced".to_string());
                            },
                            Ok(msg) => {
                                trace!("FeltClientThread::felt_client::ipc_loop(): UNEXPECTED MSG {:?}", msg);
                            },
                            Err(ipc_channel::ipc::TryRecvError::IpcError(ipc_channel::ipc::IpcError::Disconnected)) => {
                                trace!("FeltClientThread::felt_client::ipc_loop(): DISCONNECTED");
                                break;
                            },
                            Err(ipc_channel::ipc::TryRecvError::IpcError(err)) => {
                                trace!("FeltClientThread::felt_client::ipc_loop(): TryRecvError: {}", err);
                            },
                            Err(ipc_channel::ipc::TryRecvError::Empty) => {
                                trace!("FeltClientThread::felt_client::ipc_loop(): NO DATA.");
                            },
                        }

                        if thread_stop_internal.load(Ordering::Relaxed) {
                            trace!("FeltClientThread::felt_client::ipc_loop(): xpcom-shutdown-threads received!");
                            break;
                        }
                    }
                    trace!("FeltClientThread::felt_client::ipc_loop(): DONE");
                }
            trace!("FeltClientThread::felt_client::ipc_loop(): THREAD END");
        })
        .may_block(true)
        .dispatch(&thread);
        trace!("FeltClientThread::start_thread(): runnable dispatched");

        NS_OK
    }

    pub fn is_startup_complete(&self) -> bool {
        // Wait for the thread to start up.
        self.startup_ready.load(Ordering::Acquire)
    }
}

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
            let cookie = utils::nsICookie_to_Cookie(x);
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
                    versions_match, err
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
                                utils::notify_observers("felt-firefox-restarting".to_string());
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

    fn MakeBackgroundProcess(&self, success: *mut bool) -> nserror::nsresult {
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
            let rv =
                unsafe { TransformProcessType(&psn, kProcessTransformToBackgroundApplication) };
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

    fn SetTokens(
        &self,
        access_token: *const nsACString,
        refresh_token: *const nsACString,
    ) -> nserror::nsresult {
        let access_token = unsafe { (*access_token).to_string() };
        let refresh_token = unsafe { (*refresh_token).to_string() };
        match REFRESH_TOKEN.write() {
            Ok(mut t) => {
                *t = Tokens {
                    access_token,
                    refresh_token,
                };
                NS_OK
            }
            Err(_) => NS_ERROR_FAILURE,
        }
    }

    fn GetRefreshToken(&self, refresh_token: *mut nsACString) -> nserror::nsresult {
        match REFRESH_TOKEN.read() {
            Ok(t) => unsafe {
                (*refresh_token).assign(t.refresh_token.as_str());
                NS_OK
            },
            Err(_) => NS_ERROR_FAILURE,
        }
    }

    fn GetAccessToken(&self, access_token: *mut nsACString) -> nserror::nsresult {
        match REFRESH_TOKEN.read() {
            Ok(t) => unsafe {
                (*access_token).assign(t.access_token.as_str());
                NS_OK
            },
            Err(_) => NS_ERROR_FAILURE,
        }
    }

    fn GetTokens(&self, tokens: *mut ThinVec<nsCString>) -> nserror::nsresult {
        match REFRESH_TOKEN.read() {
            Ok(t) => unsafe {
                let tokens = &mut *tokens;
                let mut access_token = nsCString::new();
                (*access_token).assign(t.access_token.as_str());
                let mut refresh_token = nsCString::new();
                (*refresh_token).assign(t.refresh_token.as_str());
                tokens.push(access_token);
                tokens.push(refresh_token);
                NS_OK
            },
            Err(_) => NS_ERROR_FAILURE,
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
