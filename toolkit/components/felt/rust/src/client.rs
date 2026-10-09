/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use nserror::{
    nsresult, NS_ERROR_CONNECTION_REFUSED, NS_ERROR_FAILURE, NS_ERROR_NOT_CONNECTED, NS_OK,
};
use nsstring::nsString;
use std::cell::RefCell;
use std::ffi::{c_char, CStr, CString};
use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc, Mutex};
use xpcom::interfaces::{nsIObserver, nsIObserverService, nsISupports};
use xpcom::RefPtr;

use log::{error, trace};

use crate::message::{nsICookieWrapper, FeltMessage, FELT_IPC_VERSION};
use crate::utils::{self, Tokens, TOKENS};

/// Once set, IPC failures are expected because the browser is quitting.
static NORMAL_BROWSER_SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn is_shutdown_requested() -> bool {
    NORMAL_BROWSER_SHUTDOWN_REQUESTED.load(Ordering::Acquire)
}

#[cfg(not(test))]
fn request_browser_shutdown() {
    utils::notify_observers("felt-firefox-shutdown".to_string());
}

#[cfg(test)]
fn request_browser_shutdown() {
    tests::SHUTDOWN_REQUESTS.fetch_add(1, Ordering::AcqRel);
}

fn shutdown_browser_on_disconnect(tx: &Mutex<Option<ipc_channel::ipc::IpcSender<FeltMessage>>>) {
    let was_connected = tx.lock().expect("Could not lock sender").take().is_some();
    if !was_connected || is_shutdown_requested() {
        return;
    }
    error!("FELT IPC connection lost, shutting down the browser");
    request_browser_shutdown();
}

#[derive(Default)]
pub struct FeltIpcClient {
    tx: Arc<Mutex<Option<ipc_channel::ipc::IpcSender<FeltMessage>>>>,
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
                                tx: Arc::new(Mutex::new(Some(tx_firefox_to_felt))),
                                rx: Some(rx_firefox_to_felt),
                            }
                        }
                        _ => {
                            trace!("FeltIpcClient::new() unexpected message");
                            Self::default()
                        }
                    },
                    Err(err) => {
                        trace!("FeltIpcClient::new() rx_firefox_to_felt.recv() ERR {}", err);
                        Self::default()
                    }
                }
            }
            Err(err) => {
                trace!("FeltIpcClient::new() failed: {}", err);
                Self::default()
            }
        }
    }

    pub fn send_felt_ready(&self) {
        trace!("FeltIpcClient::send_felt_ready()");
        let msg = FeltMessage::FeltReady(std::process::id());
        if let Some(tx) = &*self.tx.lock().expect("Could not lock sender") {
            match tx.send(msg) {
                Ok(()) => trace!("FeltIpcClient::send_felt_ready() SENT"),
                Err(err) => trace!("FeltIpcClient::send_felt_ready() TX ERROR: {}", err),
            }
        }
    }

    pub fn notify_signout(&self) {
        trace!("FeltIpcClient::notify_signout()");
        let msg = FeltMessage::LogoutShutdown;
        if let Some(tx) = &*self.tx.lock().expect("Could not lock sender") {
            match tx.send(msg) {
                Ok(()) => trace!("FeltIpcClient::notify_signout() SENT"),
                Err(err) => trace!("FeltIpcClient::notify_signout() TX ERROR: {}", err),
            }
        }
    }

    pub fn request_update_check(&self) -> nsresult {
        trace!("FeltIpcClient::request_update_check()");
        match &*self.tx.lock().expect("Could not lock sender") {
            Some(tx) => match tx.send(FeltMessage::CheckForUpdates) {
                Ok(()) => NS_OK,
                Err(err) => {
                    trace!("FeltIpcClient::request_update_check() TX ERROR: {}", err);
                    NS_ERROR_CONNECTION_REFUSED
                }
            },
            None => NS_ERROR_NOT_CONNECTED,
        }
    }

    pub fn notify_crash_lock_intent(&self, lock_intent: bool) -> nsresult {
        trace!("FeltIpcClient::notify_crash_lock_intent({})", lock_intent);
        match &*self.tx.lock().expect("Could not lock sender") {
            Some(tx) => match tx.send(FeltMessage::CrashLockIntent(lock_intent)) {
                Ok(()) => NS_OK,
                Err(err) => {
                    trace!(
                        "FeltIpcClient::notify_crash_lock_intent() TX ERROR: {}",
                        err
                    );
                    NS_ERROR_CONNECTION_REFUSED
                }
            },
            None => NS_ERROR_NOT_CONNECTED,
        }
    }

    pub fn notify_refresh_tokens(&self) {
        trace!("FeltIpcClient::notify_refresh_tokens()");
        let msg = FeltMessage::RefreshTokens;
        if let Some(tx) = &*self.tx.lock().expect("Could not lock sender") {
            match tx.send(msg) {
                Ok(()) => trace!("FeltIpcClient::notify_refresh_tokens() SENT"),
                Err(err) => trace!("FeltIpcClient::notify_refresh_tokens() TX ERROR: {}", err),
            }
        }
    }

    pub fn report_version(&self) -> bool {
        trace!("FeltIpcClient::report_version()");
        let msg = FeltMessage::VersionProbe(FELT_IPC_VERSION);
        if let Some(tx) = &*self.tx.lock().expect("Could not lock sender") {
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
            tx: Option<ipc_channel::ipc::IpcSender<FeltMessage>>,
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
                        NORMAL_BROWSER_SHUTDOWN_REQUESTED.store(true, Ordering::Release);
                        if let Err(err) = self.thread_stop.send(true) {
                            trace!("FeltClientThread::start_thread::observe() xpcom-shutdown thread_stop.send() error: {}", err);
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

                        if let Some(ref tx) = self.tx {
                            match obsData.trim() {
                                "restart" => {
                                    trace!("FeltClientThread::start_thread::observe() quit-application: restart");
                                    let lock_intent =
                                        crate::RESTART_LOCK_INTENT.load(Ordering::Relaxed);
                                    if let Err(err) = tx.send(FeltMessage::Restarting(lock_intent))
                                    {
                                        trace!("FeltClientThread::start_thread::observe() failed to send restart: {:?}", err);
                                    }
                                }
                                "shutdown" => {
                                    trace!("FeltClientThread::start_thread::observe() quit-application: shutdown");
                                    let lock_intent =
                                        crate::SHUTDOWN_LOCK_INTENT.load(Ordering::Relaxed);
                                    if let Err(err) = tx.send(FeltMessage::Exiting(lock_intent)) {
                                        trace!("FeltClientThread::start_thread::observe() failed to send shutdown: {:?}", err);
                                    }
                                }
                                _ => {
                                    trace!("FeltClientThread::start_thread::observe() quit-application: something else? Ignore");
                                }
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

        // Clone tx for the observer to send messages directly
        let client = self.ipc_client.borrow_mut();
        let tx_for_observer = client.tx.lock().expect("Could not lock sender").clone();
        drop(client);

        let (tx_thread, rx_thread) = ipc_channel::ipc::channel::<bool>().unwrap();

        let observer = Observer::allocate(InitObserver {
            profile_ready: profile_ready.clone(),
            pending_cookies: pending_cookies.clone(),
            thread_stop: tx_thread,
            tx: tx_for_observer,
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
        let tx_for_thread = client.tx.clone();
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
                    Err(err) => {
                        trace!("FELT IPC selection failed: {}", err);
                        shutdown_browser_on_disconnect(&tx_for_thread);
                        break;
                    }
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
                                Ok(FeltMessage::UpdateReady) => {
                                    trace!("FeltClientThread::felt_client::ipc_loop(): UpdateReady");
                                    utils::notify_observers("felt-update-ready".to_string());
                                },
                                Ok(FeltMessage::AccessToken((access_token, expires_at))) => {
                                    if let Ok(mut tokens) = TOKENS.write() {
                                        *tokens = Tokens { access_token, refresh_token: String::default(), expires_at };
                                        trace!("FeltClientThread::felt_client::ipc_loop(): access_token({})", tokens.access_token);
                                        utils::notify_observers("felt-firefox-access-token-refreshed".to_string());
                                    } else {
                                        trace!("FeltClientThread::felt_client::ipc_loop(): ERROR setting access token");
                                    }
                                }
                                Ok(FeltMessage::PrimarySecret(hex)) => {
                                    // Hand the console-supplied primarySecret straight to
                                    // its consumers; Felt keeps no copy.
                                    // Do NOT trace the value.
                                    utils::deliver_primary_secret(hex);
                                    trace!("FeltClientThread::felt_client::ipc_loop(): PrimarySecret delivered to storage");
                                }
                                Ok(FeltMessage::Shutdown) => {
                                    trace!("FeltClientThread::felt_client::ipc_loop(): Shutdown");
                                    utils::notify_observers("felt-firefox-shutdown".to_string());
                                },
                                Ok(FeltMessage::OpenURL((url, disposition, focus_hint))) => {
                                    trace!(
                                        "FeltClientThread::felt_client::ipc_loop(): OpenURL({}, {}, {:?})",
                                        url,
                                        disposition,
                                        focus_hint
                                    );
                                    utils::open_url_in_firefox(url, disposition, focus_hint);
                                },
                                Ok(msg) => {
                                    trace!("FeltClientThread::felt_client::ipc_loop(): UNEXPECTED MSG {:?}", msg);
                                },
                                Err(serde_error) => {
				    trace!("FeltClientThread::felt_client::ipc_loop(): MESSAGE SERDE ERROR: {}", serde_error);
                                },
                            }
                        },

                        ipc_channel::ipc::IpcSelectionResult::MessageReceived(id, data) if id == rx_thread_id => {
                            trace!("FeltClientThread::felt_client::ipc_loop(): MessageReceived THREAD id={} rx_client_id={} rx_thread_id={}...", id, rx_client_id, rx_thread_id);
                            let msg: Result<bool, ipc_channel::SerDeError> = data.to();
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
                            if id == rx_client_id {
                                shutdown_browser_on_disconnect(&tx_for_thread);
                            }
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

    pub fn is_disconnected(&self) -> bool {
        self.ipc_client
            .borrow()
            .tx
            .lock()
            .expect("Could not lock sender")
            .is_none()
    }

    pub fn is_startup_complete(&self) -> bool {
        // Wait for the thread to start up.
        self.startup_ready.load(Ordering::Acquire)
    }

    pub fn send_felt_ready(&self) {
        trace!("FeltClientThread::send_felt_ready()");
        let client = self.ipc_client.borrow();
        client.send_felt_ready();
    }

    pub fn notify_signout(&self) {
        trace!("FeltClientThread::notify_signout()");
        let client = self.ipc_client.borrow();
        client.notify_signout();
    }

    pub fn request_update_check(&self) -> nsresult {
        trace!("FeltClientThread::request_update_check()");
        self.ipc_client.borrow().request_update_check()
    }

    pub fn notify_crash_lock_intent(&self, lock_intent: bool) -> nsresult {
        trace!(
            "FeltClientThread::notify_crash_lock_intent({})",
            lock_intent
        );
        let client = self.ipc_client.borrow();
        client.notify_crash_lock_intent(lock_intent)
    }

    pub fn notify_refresh_tokens(&self) {
        trace!("FeltClientThread::refresh_tokens()");
        let client = self.ipc_client.borrow();
        client.notify_refresh_tokens();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::MutexGuard;

    pub(super) static SHUTDOWN_REQUESTS: AtomicUsize = AtomicUsize::new(0);

    // The flag and counter are process-wide, so tests must not run concurrently.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn reset_shutdown_state() -> MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        NORMAL_BROWSER_SHUTDOWN_REQUESTED.store(false, Ordering::Release);
        SHUTDOWN_REQUESTS.store(0, Ordering::Release);
        guard
    }

    fn connected_client() -> (FeltClientThread, ipc_channel::ipc::IpcReceiver<FeltMessage>) {
        let (tx, rx) = ipc_channel::ipc::channel().unwrap();
        (
            FeltClientThread {
                ipc_client: RefCell::new(FeltIpcClient {
                    tx: Arc::new(Mutex::new(Some(tx))),
                    rx: None,
                }),
                startup_ready: Arc::new(AtomicBool::new(false)),
            },
            rx,
        )
    }

    #[test]
    fn channel_closed_requests_shutdown_without_completing_startup() {
        let _guard = reset_shutdown_state();
        let (client, _rx) = connected_client();
        let (server_tx, client_rx) = ipc_channel::ipc::channel::<FeltMessage>().unwrap();
        let mut receivers = ipc_channel::ipc::IpcReceiverSet::new().unwrap();
        let client_id = receivers.add(client_rx).unwrap();
        drop(server_tx);

        let events = receivers.select().unwrap();
        assert_eq!(events.len(), 1);
        assert!(
            matches!(events[0], ipc_channel::ipc::IpcSelectionResult::ChannelClosed(id) if id == client_id)
        );
        shutdown_browser_on_disconnect(&client.ipc_client.borrow().tx);

        assert!(client.is_disconnected());
        assert!(!client.is_startup_complete());
        assert!(!is_shutdown_requested());
        assert_eq!(SHUTDOWN_REQUESTS.load(Ordering::Acquire), 1);
        assert!(client.request_update_check() == NS_ERROR_NOT_CONNECTED);

        shutdown_browser_on_disconnect(&client.ipc_client.borrow().tx);
        assert_eq!(SHUTDOWN_REQUESTS.load(Ordering::Acquire), 1);
    }

    #[test]
    fn channel_closed_during_normal_shutdown_requests_nothing() {
        let _guard = reset_shutdown_state();
        let (client, _rx) = connected_client();
        NORMAL_BROWSER_SHUTDOWN_REQUESTED.store(true, Ordering::Release);

        assert!(!client.is_disconnected());
        assert!(!client.is_startup_complete());
        shutdown_browser_on_disconnect(&client.ipc_client.borrow().tx);
        assert!(client.is_disconnected());
        assert_eq!(SHUTDOWN_REQUESTS.load(Ordering::Acquire), 0);
    }

    #[test]
    fn send_failure_does_not_request_shutdown() {
        let _guard = reset_shutdown_state();
        let (client, rx) = connected_client();
        drop(rx);

        assert!(client.request_update_check() == NS_ERROR_CONNECTION_REFUSED);
        assert!(!client.is_disconnected());
        assert!(!is_shutdown_requested());
        assert_eq!(SHUTDOWN_REQUESTS.load(Ordering::Acquire), 0);
    }

    #[test]
    fn missing_sender_does_not_request_shutdown() {
        let _guard = reset_shutdown_state();
        let client = FeltIpcClient::default();

        assert!(client.request_update_check() == NS_ERROR_NOT_CONNECTED);
        assert!(!is_shutdown_requested());
        assert_eq!(SHUTDOWN_REQUESTS.load(Ordering::Acquire), 0);
    }

    #[test]
    fn successful_send_requests_nothing() {
        let _guard = reset_shutdown_state();
        let (client, rx) = connected_client();

        assert!(client.request_update_check() == NS_OK);
        assert!(matches!(rx.recv().unwrap(), FeltMessage::CheckForUpdates));
        assert!(!client.is_disconnected());
        assert!(!is_shutdown_requested());
        assert_eq!(SHUTDOWN_REQUESTS.load(Ordering::Acquire), 0);
    }
}
