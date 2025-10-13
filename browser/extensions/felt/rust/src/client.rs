/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use ipc_channel;

use nserror::{nsresult, NS_ERROR_FAILURE, NS_OK};
use nsstring::nsString;
use std::cell::RefCell;
use std::ffi::{c_char, CStr, CString};
use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc, Mutex};
use std::time::Duration;
use xpcom::interfaces::{nsIObserver, nsIObserverService, nsISupports};
use xpcom::RefPtr;

use log::trace;

use crate::message::{FeltMessage, FELT_IPC_VERSION};
use crate::utils;

pub static FELT_CLIENT: Mutex<Option<FeltClientThread>> = Mutex::new(None);

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
                }
                Ok(FeltMessage::VersionValidated(false)) => {
                    trace!("FeltIpcClient::report_version() REJRECTED");
                    return false;
                }
                Ok(_) => {
                    trace!("FeltIpcClient::report_version() UNEXPECTED MSG");
                    return false;
                }
                Err(err) => {
                    trace!("FeltIpcClient::report_version() RX ERROR: {}", err);
                    return false;
                }
            }

            match rx.recv() {
                Ok(FeltMessage::ProfileKey(key)) => {
                    trace!("FeltClientThread::felt_client::ipc_loop(): ProfileKey: {}", key);
                    let mut state = crate::PROFILE_KEY.lock().expect("Could not lock mutex");
                    let key_c = CString::new(key).expect("Could not build CString");
                    trace!("FeltClientThread::felt_client::ipc_loop(): ProfileKey: Some({:?}) => {:?}", key_c, key_c.as_ptr());
                    *state = Some(key_c);
                }
                Ok(_) => {
                    trace!("FeltIpcClient::report_version() UNEXPECTED MSG");
                    return false;
                }
                Err(err) => {
                    trace!("FeltIpcClient::report_version() RX ERROR: {}", err);
                    return false;
                }
            }
        } else {
            trace!("FeltIpcClient::report_version() RX MISSING?");
            return false;
        }

        true
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
                                trace!("FeltClientThread::start_thread::observe() quit-application: restart");
                                self.notify_restart.store(true, Ordering::Relaxed);
                            }
                            _ => {
                                trace!("FeltClientThread::start_thread::observe() quit-application: something else? Ignore");
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
                                trace!("FeltClientThread::felt_client::ipc_loop(): StringPreference({}, {})", name, value);
                                utils::inject_string_pref(name, value);
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
