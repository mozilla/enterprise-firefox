/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use nserror::{nsresult, NS_ERROR_FAILURE, NS_OK};
use nsstring::nsString;
use std::cell::RefCell;
use std::ffi::{c_char, CStr, CString};
use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc, Mutex};
use xpcom::interfaces::{nsIObserver, nsIObserverService, nsISupports};
use xpcom::RefPtr;

use log::trace;

use crate::message::{nsICookieWrapper, FeltMessage, FELT_IPC_VERSION};
use crate::utils::{self, Tokens, TOKENS};

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

    pub fn send_extension_ready(&self) {
        trace!("FeltIpcClient::send_extension_ready()");
        let msg = FeltMessage::ExtensionReady;
        if let Some(tx) = &self.tx {
            match tx.send(msg) {
                Ok(()) => trace!("FeltIpcClient::send_extension_ready() SENT"),
                Err(err) => trace!("FeltIpcClient::send_extension_ready() TX ERROR: {}", err),
            }
        }
    }

    pub fn notify_signout(&self) {
        trace!("FeltIpcClient::notify_signout()");
        let msg = FeltMessage::LogoutShutdown;
        if let Some(tx) = &self.tx {
            match tx.send(msg) {
                Ok(()) => trace!("FeltIpcClient::notify_signout() SENT"),
                Err(err) => trace!("FeltIpcClient::notify_signout() TX ERROR: {}", err),
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
            pending_cookies: Arc<Mutex<Vec<nsICookieWrapper>>>,
            profile_ready: Arc<AtomicBool>,
            thread_stop: ipc_channel::ipc::IpcSender<bool>,
            restart_tx: Option<ipc_channel::ipc::IpcSender<FeltMessage>>,
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
                    Ok("profile-after-change") => {
                        trace!("FeltClientThread::start_thread::observe() profile-after-change");
                        self.profile_ready.store(true, Ordering::Relaxed);
                        if let Ok(mut cookies) = self.pending_cookies.lock() {
                            if !cookies.is_empty() {
                                trace!("FeltClientThread::start_thread::observe(): Profile ready! Start cookies injection!");
                                cookies.drain(..).for_each(utils::inject_one_cookie);
                                trace!("FeltClientThread::start_thread::observe(): Profile ready! Finished cookies injection!");
                            }
                        }
                    }
                    Ok("xpcom-shutdown") => {
                        trace!("FeltClientThread::start_thread::observe() xpcom-shutdown");
                        if let Err(err) = self.thread_stop.send(true) {
                            trace!("FeltClientThread::start_thread::observe() xpcom-shutdown thread_stop.send() error: {}", err);
                            panic!(
                                "FeltClientThread failed to send stop on xpcom-shutdown. Error: {}",
                                err
                            );
                        }
                    }
                    Ok("quit-application") => {
                        trace!("FeltClientThread::start_thread::observe() quit-application");
                        // notification is sent from https://searchfox.org/firefox-main/rev/856a307913c2b73765b4e88d32cf15ed05549cae/toolkit/components/startup/nsAppStartup.cpp#494
                        let len = unsafe {
                            let mut data_len = 0;
                            let mut ptr: *const u16 = data;
                            while !ptr.is_null() && *ptr != 0x0000 {
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
                                if let Some(ref tx) = self.restart_tx {
                                    if let Err(err) = tx.send(FeltMessage::Restarting) {
                                        trace!("FeltClientThread::start_thread::observe() failed to send restart: {:?}", err);
                                    }
                                }
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

        let profile_after_change = CString::new("profile-after-change").unwrap();
        let xpcom_shutdown = CString::new("xpcom-shutdown").unwrap();
        let quit_application = CString::new("quit-application").unwrap();

        let profile_ready = Arc::new(AtomicBool::new(false));

        let pending_cookies: Arc<Mutex<Vec<nsICookieWrapper>>> = Arc::new(Mutex::new(Vec::new()));

        // Clone tx for the observer to send restart messages directly
        let client = self.ipc_client.borrow_mut();
        let tx_for_observer = client.tx.clone();
        drop(client);

        let (tx_thread, rx_thread) = ipc_channel::ipc::channel::<bool>().unwrap();

        let observer = Observer::allocate(InitObserver {
            profile_ready: profile_ready.clone(),
            pending_cookies: pending_cookies.clone(),
            thread_stop: tx_thread,
            restart_tx: tx_for_observer,
        });
        let mut rv = unsafe {
            obssvc.AddObserver(
                observer.coerce::<nsIObserver>(),
                profile_after_change.as_ptr(),
                false,
            )
        };
        assert!(rv.succeeded());

        rv = unsafe {
            obssvc.AddObserver(
                observer.coerce::<nsIObserver>(),
                xpcom_shutdown.as_ptr(),
                false,
            )
        };
        assert!(rv.succeeded());

        rv = unsafe {
            obssvc.AddObserver(
                observer.coerce::<nsIObserver>(),
                quit_application.as_ptr(),
                false,
            )
        };
        assert!(rv.succeeded());
        trace!("FeltClientThread::start_thread(): added observers");

        let barrier = self.startup_ready.clone();
        let profile_ready_internal = profile_ready.clone();

        // Clone the tx: one for the background thread to signal existing,
        // one for us to immediately notify Felt is ready (to receive URLs etc),
        // this works because ipc-channel::ipc::IpcSender is Send + Sync.
        // Take the rx, only needed in the receive thread (and it's not Sync).
        let mut client = self.ipc_client.borrow_mut();
        let rx_for_thread = client.rx.take();
        drop(client);

        trace!("FeltClientThread::start_thread(): started thread: build runnable");
        let _ = moz_task::RunnableBuilder::new("felt_client::ipc_loop", move || {
            trace!("FeltClientThread::start_thread(): felt_client thread runnable");
            trace!("FeltClientThread::start_thread(): felt_client version OK");

            let mut rx_set = ipc_channel::ipc::IpcReceiverSet::new().unwrap();
            let rx_thread_id = rx_set.add(rx_thread).unwrap();
            let rx_client_id = rx_set.add(rx_for_thread.unwrap()).unwrap();

            'thread_loop: loop {
                let events = match rx_set.select() {
                    Ok(events) => events,
                    Err(_) => break,
                };

                for event in events.into_iter() {
                    match event {
                        ipc_channel::ipc::IpcSelectionResult::MessageReceived(id, data) if id == rx_client_id => {
                            match data.to() {
                                Ok(FeltMessage::Cookie(felt_cookie)) => {
                                    trace!("FeltClientThread::felt_client::ipc_loop(): received cookie: {:?}", felt_cookie.clone());
                                    if profile_ready_internal.load(Ordering::Relaxed) {
                                        utils::inject_one_cookie(felt_cookie);
                                    } else if let Ok(mut cookies) = pending_cookies.lock() {
                                        cookies.push(felt_cookie);
                                    }
                                },
                                Ok(FeltMessage::BoolPreference((name, value))) => {
                                    trace!("FeltClientThread::felt_client::ipc_loop(): BoolPreference({}, {})", name, value);
                                    utils::inject_bool_pref(name, value);
                                },
                                Ok(FeltMessage::StringPreference((name, value))) => {
                                    if name == "enterprise.console.address" {
                                        utils::set_console_url(value.clone());
                                    }
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
                                Ok(FeltMessage::Tokens((access_token, refresh_token, expires_at))) => {
                                    if let Ok(mut tokens) = TOKENS.write() {
                                        *tokens = Tokens {access_token, refresh_token, expires_at};
                                        trace!("FeltClientThread::felt_client::ipc_loop(): RefreshToken({})", tokens.refresh_token);
                                    } else {
                                        trace!("FeltClientThread::felt_client::ipc_loop(): ERROR setting RefreshToken({})", refresh_token);
                                    }
                                }
                                Ok(FeltMessage::OpenURL((url, disposition))) => {
                                    trace!(
                                        "FeltClientThread::felt_client::ipc_loop(): OpenURL({}, {})",
                                        url,
                                        disposition
                                    );
                                    utils::open_url_in_firefox(url, disposition);
                                },
                                Ok(msg) => {
                                    trace!("FeltClientThread::felt_client::ipc_loop(): UNEXPECTED MSG {:?}", msg);
                                },
                                Err(boxed_error) => {
                                    match *boxed_error {
                                        ipc_channel::ErrorKind::Io(err) => {
                                            trace!("FeltClientThread::felt_client::ipc_loop(): MESSAGE I/O ERROR: {}", err);
                                        },
                                        err => {
                                            trace!("FeltClientThread::felt_client::ipc_loop(): MESSAGE OTHER ERROR: {}", err);
                                        },
                                    }
                                }
                            }
                        },

                        ipc_channel::ipc::IpcSelectionResult::MessageReceived(id, data) if id == rx_thread_id => {
                            trace!("FeltClientThread::felt_client::ipc_loop(): MessageReceived THREAD id={} rx_client_id={} rx_thread_id={}...", id, rx_client_id, rx_thread_id);
                            let msg: Result<bool, Box<ipc_channel::ErrorKind>> = data.to();
                            match msg {
                                Ok(true) => {
                                    trace!("FeltClientThread::felt_client::ipc_loop(): TRUE on THREAD ... STOPPING");
                                    break 'thread_loop;
                                },
                                Ok(false) => {
                                    trace!("FeltClientThread::felt_client::ipc_loop(): FALSE on THREAD? ??...");
                                    panic!("Unexpected message received");
                                },
                                Err(err) => {
                                    trace!("FeltClientThread::felt_client::ipc_loop(): ERROR on THREAD? ??... {:?}", err);
                                    panic!("Unexpected error: {:?}", err);
                                }
                            }
                        },

                        ipc_channel::ipc::IpcSelectionResult::MessageReceived(id, _) => {
                            trace!("FeltClientThread::felt_client::ipc_loop(): MessageReceived OTHER id={} rx_client_id={} rx_thread_id={}...", id, rx_client_id, rx_thread_id);
                        },

                        ipc_channel::ipc::IpcSelectionResult::ChannelClosed(id) => {
                            trace!("FeltClientThread::felt_client::ipc_loop(): ChannelClosed id={} rx_client_id={} rx_thread_id={}...", id, rx_client_id, rx_thread_id);
                            break 'thread_loop;
                        }
                    }
                }
                trace!("FeltClientThread::felt_client::ipc_loop(): DONE");
            }
            trace!("FeltClientThread::felt_client::ipc_loop(): THREAD END");
        })
        .may_block(true)
        .dispatch(&thread);
        trace!("FeltClientThread::start_thread(): task dispatched");

        NS_OK
    }

    pub fn is_startup_complete(&self) -> bool {
        // Wait for the thread to start up.
        self.startup_ready.load(Ordering::Acquire)
    }

    pub fn send_extension_ready(&self) {
        trace!("FeltClientThread::send_extension_ready()");
        let client = self.ipc_client.borrow();
        client.send_extension_ready();
    }

    pub fn notify_signout(&self) {
        trace!("FeltClientThread::notify_signout()");
        let client = self.ipc_client.borrow();
        client.notify_signout();
    }
}
