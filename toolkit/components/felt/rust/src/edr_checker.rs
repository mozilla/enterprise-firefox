/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use moz_task::{DispatchOptions, Task, TaskRunnable, ThreadPtrHandle, ThreadPtrHolder};
use nserror::{nsresult, NS_ERROR_FAILURE, NS_ERROR_NULL_POINTER, NS_OK};
use nsstring::nsCString;
use thin_vec::ThinVec;
use xpcom::interfaces::nsIEdrCheckerCallback;
use xpcom::RefPtr;

#[cfg(target_os = "linux")]
use crate::edr_checker_linux::Snapshot;
#[cfg(target_os = "macos")]
use crate::edr_checker_macos::Snapshot;
#[cfg(target_os = "windows")]
use crate::edr_checker_win::Snapshot;

// ---------------------------------------------------------------------------
// EDR identifiers — adding a variant here forces a compile error in
// detection_methods() on every platform until it is handled.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum EdrId {
    CrowdStrike,         // CrowdStrike Falcon
    CortexXdr,           // Palo Alto Networks Cortex XDR (formerly Traps)
    SentinelOne,         // SentinelOne Singularity
    MsDefender,          // Microsoft Defender for Endpoint
    CarbonBlack,         // VMware Carbon Black Cloud (Broadcom)
    Trellix,             // Trellix Endpoint Security (formerly McAfee/FireEye)
    Sophos,              // Sophos Intercept X
    CiscoSecureEndpoint, // Cisco Secure Endpoint (formerly AMP)
    Eset,                // ESET Endpoint Security
    Cylance,             // BlackBerry Cylance
    Symantec,            // Symantec Endpoint Security / Protection
    TrendMicro,          // Trend Micro Apex One
}

impl EdrId {
    // The complete catalog of known EDR agents. This is the single source of
    // truth; callers (including the device posture payload) enumerate via the
    // getPresentEdrs() XPCOM method rather than hardcoding identifiers.
    pub const ALL: &'static [EdrId] = &[
        EdrId::CrowdStrike,
        EdrId::CortexXdr,
        EdrId::SentinelOne,
        EdrId::MsDefender,
        EdrId::CarbonBlack,
        EdrId::Trellix,
        EdrId::Sophos,
        EdrId::CiscoSecureEndpoint,
        EdrId::Eset,
        EdrId::Cylance,
        EdrId::Symantec,
        EdrId::TrendMicro,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            EdrId::CrowdStrike => "crowdstrike",
            EdrId::CortexXdr => "cortex-xdr",
            EdrId::SentinelOne => "sentinelone",
            EdrId::MsDefender => "ms-defender",
            EdrId::CarbonBlack => "carbon-black",
            EdrId::Trellix => "trellix",
            EdrId::Sophos => "sophos",
            EdrId::CiscoSecureEndpoint => "cisco-secure-endpoint",
            EdrId::Eset => "eset",
            EdrId::Cylance => "cylance",
            EdrId::Symantec => "symantec",
            EdrId::TrendMicro => "trend-micro",
        }
    }

    /// Maps a string identifier (as produced by `as_str`) back to an `EdrId`,
    /// or `None` for an unknown identifier.
    pub fn from_id(s: &str) -> Option<EdrId> {
        EdrId::ALL.iter().copied().find(|id| id.as_str() == s)
    }
}

// ---------------------------------------------------------------------------
// Detection methods — tried in order until one succeeds
// ---------------------------------------------------------------------------

pub enum DetectMethod {
    ProcessPath {
        path_prefixes: &'static [&'static str],
    },
    #[cfg(target_os = "macos")]
    SystemExtension { identifier: &'static str },
    #[cfg(target_os = "linux")]
    Service { name: &'static str },
    #[cfg(target_os = "linux")]
    DirExists { path: &'static str },
    #[cfg(target_os = "windows")]
    WindowsService { service_name: &'static str },
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    ProcessName { exe_name: &'static str },
}

// ---------------------------------------------------------------------------
// Per-platform detection methods — exhaustive match on EdrId ensures every
// EDR is covered. Adding a new EdrId variant without handling it here is a
// compile error.
//
// The identifiers below (service names, process names, paths, system
// extension IDs) are taken from the EDAMAME threatmodels
// (https://github.com/edamametechnologies/threatmodels), corroborated with
// vendor documentation. An empty method list means the agent is not
// detectable on that platform from those references.
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn detection_methods(id: EdrId) -> &'static [DetectMethod] {
    match id {
        EdrId::CrowdStrike => &[DetectMethod::SystemExtension {
            identifier: "com.crowdstrike.falcon.Agent",
        }],
        EdrId::CortexXdr => &[DetectMethod::ProcessPath {
            path_prefixes: &["/Library/Application Support/PaloAltoNetworks/Traps/"],
        }],
        EdrId::SentinelOne => &[DetectMethod::SystemExtension {
            identifier: "com.sentinelone.sentineld",
        }],
        EdrId::MsDefender => &[DetectMethod::ProcessPath {
            path_prefixes: &["/Library/Application Support/Microsoft/Defender/"],
        }],
        EdrId::CarbonBlack => &[DetectMethod::ProcessPath {
            path_prefixes: &["/Applications/VMware Carbon Black Cloud/"],
        }],
        // Not supported on macOS.
        EdrId::Trellix => &[],
        EdrId::Sophos => &[DetectMethod::ProcessPath {
            path_prefixes: &["/Library/Sophos Anti-Virus/"],
        }],
        // Not supported on macOS.
        EdrId::CiscoSecureEndpoint => &[],
        EdrId::Eset => &[DetectMethod::ProcessPath {
            path_prefixes: &["/Applications/ESET Endpoint Security.app/"],
        }],
        EdrId::Cylance => &[DetectMethod::ProcessPath {
            path_prefixes: &["/Library/Application Support/Cylance/Desktop/"],
        }],
        EdrId::Symantec => &[DetectMethod::ProcessName {
            exe_name: "SymDaemon",
        }],
        EdrId::TrendMicro => &[
            DetectMethod::SystemExtension {
                identifier: "com.trendmicro.icore.es",
            },
            DetectMethod::ProcessName {
                exe_name: "iCoreService",
            },
        ],
    }
}

#[cfg(target_os = "linux")]
fn detection_methods(id: EdrId) -> &'static [DetectMethod] {
    match id {
        EdrId::CrowdStrike => &[
            DetectMethod::Service {
                name: "falcon-sensor",
            },
            DetectMethod::DirExists {
                path: "/opt/CrowdStrike",
            },
        ],
        EdrId::CortexXdr => &[
            DetectMethod::Service { name: "traps_pmd" },
            DetectMethod::DirExists {
                path: "/opt/traps/bin",
            },
        ],
        EdrId::SentinelOne => &[
            DetectMethod::Service {
                name: "sentinelone",
            },
            DetectMethod::DirExists {
                path: "/opt/sentinelone",
            },
        ],
        EdrId::MsDefender => &[
            DetectMethod::ProcessPath {
                path_prefixes: &["/opt/microsoft/mdatp/"],
            },
            DetectMethod::DirExists {
                path: "/opt/microsoft/mdatp",
            },
        ],
        EdrId::CarbonBlack => &[DetectMethod::DirExists {
            path: "/opt/carbonblack/psc/bin",
        }],
        // Not supported on Linux.
        EdrId::Trellix => &[],
        EdrId::Sophos => &[
            DetectMethod::Service { name: "sophos-spl" },
            DetectMethod::DirExists {
                path: "/opt/sophos-spl",
            },
        ],
        EdrId::CiscoSecureEndpoint => &[DetectMethod::DirExists {
            path: "/opt/cisco/amp",
        }],
        EdrId::Eset => &[DetectMethod::Service { name: "esets" }],
        EdrId::Cylance => &[DetectMethod::Service { name: "cylancesvc" }],
        // Not supported on Linux.
        EdrId::Symantec => &[],
        // Not supported on Linux.
        EdrId::TrendMicro => &[],
    }
}

#[cfg(target_os = "windows")]
fn detection_methods(id: EdrId) -> &'static [DetectMethod] {
    match id {
        EdrId::CrowdStrike => &[DetectMethod::WindowsService {
            service_name: "CSFalconService",
        }],
        EdrId::CortexXdr => &[
            DetectMethod::WindowsService {
                service_name: "CyveraService",
            },
            DetectMethod::ProcessPath {
                path_prefixes: &["C:\\Program Files\\Palo Alto Networks\\Traps\\"],
            },
        ],
        EdrId::SentinelOne => &[DetectMethod::WindowsService {
            service_name: "SentinelAgent",
        }],
        EdrId::MsDefender => &[DetectMethod::WindowsService {
            service_name: "Sense",
        }],
        EdrId::CarbonBlack => &[
            DetectMethod::WindowsService {
                service_name: "CbDefense",
            },
            DetectMethod::ProcessName { exe_name: "cb.exe" },
        ],
        EdrId::Trellix => &[
            DetectMethod::WindowsService {
                service_name: "mfemms",
            },
            DetectMethod::WindowsService {
                service_name: "mfevtps",
            },
            DetectMethod::WindowsService {
                service_name: "mfefire",
            },
        ],
        EdrId::Sophos => &[
            DetectMethod::WindowsService {
                service_name: "SEDService",
            },
            DetectMethod::WindowsService {
                service_name: "SSPService",
            },
        ],
        // Not supported on Windows.
        EdrId::CiscoSecureEndpoint => &[],
        EdrId::Eset => &[DetectMethod::WindowsService {
            service_name: "ekrn",
        }],
        EdrId::Cylance => &[DetectMethod::WindowsService {
            service_name: "CylanceSvc",
        }],
        EdrId::Symantec => &[
            DetectMethod::WindowsService {
                service_name: "SepMasterService",
            },
            DetectMethod::WindowsService {
                service_name: "sepWscSvc",
            },
        ],
        EdrId::TrendMicro => &[
            DetectMethod::WindowsService {
                service_name: "TMBMSRV",
            },
            DetectMethod::WindowsService {
                service_name: "TmPfw",
            },
            DetectMethod::WindowsService {
                service_name: "ntrtscan",
            },
        ],
    }
}

// ---------------------------------------------------------------------------
// Detection orchestration
// ---------------------------------------------------------------------------

// Detection results are cached so that repeated device-posture collections do
// not re-enumerate processes and re-query services every time. The window is
// comfortably longer than the default console poll interval (~60s) so a single
// detection serves several polls, while staying short enough that an agent
// installed/removed is reflected reasonably quickly.
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);

// Per-agent cache of (time detected, present?). Guarded by a Mutex because the
// detection runs on a moz_task background thread.
static CACHE: Mutex<Option<HashMap<EdrId, (Instant, bool)>>> = Mutex::new(None);

// Upper bound on a single external probe (a service-status command, the
// system-extension listing, etc.). A probe that exceeds this is treated as
// "could not determine" so one wedged command cannot stall the whole sweep.
// This is independent of, and shorter than, the JS-side EDR_DETECTION_TIMEOUT_MS
// that bounds the caller.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Runs `f` on a helper thread and waits up to `timeout` for its result,
/// returning `None` if it does not finish in time. The helper thread is not
/// cancelled (there is no portable way to kill a thread blocked in a syscall),
/// so a truly wedged command leaves one lingering thread; the in-flight guard
/// below keeps that from compounding across overlapping sweeps.
pub(crate) fn run_bounded<T, F>(timeout: Duration, f: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    if thread::Builder::new()
        .spawn(move || {
            let _ = tx.send(f());
        })
        .is_err()
    {
        return None;
    }
    rx.recv_timeout(timeout).ok()
}

// Ensures only one detection sweep runs at a time. The console controls the
// poll interval, so we cannot assume it stays at its ~60s default; a shorter
// interval than a sweep takes would otherwise let sweeps stack up, each
// spawning its own probes. A sweep that is skipped returns whatever the cache
// already holds.
static DETECTION_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct InFlightGuard;

impl InFlightGuard {
    fn try_acquire() -> Option<InFlightGuard> {
        if DETECTION_IN_FLIGHT.swap(true, Ordering::AcqRel) {
            None
        } else {
            Some(InFlightGuard)
        }
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        DETECTION_IN_FLIGHT.store(false, Ordering::Release);
    }
}

/// Determines which of `requested` agents are present, returning their string
/// identifiers. A single system snapshot is captured and reused across all
/// agents that still need detection (i.e. are not already cached and fresh).
///
/// Runs on a background thread; must not touch main-thread-only state.
fn detect_present_edrs(requested: &[EdrId]) -> Vec<&'static str> {
    let now = Instant::now();

    // Figure out which agents are missing from the cache or have gone stale.
    let mut needs_detection: Vec<EdrId> = Vec::new();
    {
        let cache = CACHE.lock().unwrap();
        for &id in requested {
            let fresh = cache
                .as_ref()
                .and_then(|map| map.get(&id))
                .is_some_and(|(at, _)| now.duration_since(*at) < CACHE_TTL);
            if !fresh {
                needs_detection.push(id);
            }
        }
    }

    // Run at most one sweep at a time. If another thread is already probing,
    // skip this sweep and fall through to return whatever the cache currently
    // holds, rather than dispatching a duplicate sweep that would compete for
    // (and re-spawn) the same probes.
    if !needs_detection.is_empty() {
        if let Some(_in_flight) = InFlightGuard::try_acquire() {
            // Capture the system state once and evaluate every stale agent
            // against it, instead of re-enumerating per agent/method.
            //
            // Detection is performed *without* holding the cache lock:
            // matches() enumerates processes and may run blocking commands/APIs,
            // so holding the lock here would let one slow or hung probe block
            // every other EDR request. We take the lock only briefly afterwards
            // to publish results.
            let snapshot = Snapshot::capture();
            let detected: Vec<(EdrId, bool)> = needs_detection
                .iter()
                .map(|&id| {
                    let present = detection_methods(id)
                        .iter()
                        .any(|method| snapshot.matches(id.as_str(), method));
                    (id, present)
                })
                .collect();

            let mut cache = CACHE.lock().unwrap();
            let map = cache.get_or_insert_with(HashMap::new);
            for (id, present) in detected {
                map.insert(id, (now, present));
            }
        }
    }

    let cache = CACHE.lock().unwrap();
    requested
        .iter()
        .filter_map(|&id| {
            let present = cache.as_ref()?.get(&id)?.1;
            present.then(|| id.as_str())
        })
        .collect()
}

/// Resolves the caller-provided identifier list into concrete agents to probe.
/// An empty list means "every known agent"; unknown identifiers are silently
/// ignored so callers can ask for agents this build may not know about.
fn resolve_requested(requested_ids: &ThinVec<nsCString>) -> Vec<EdrId> {
    if requested_ids.is_empty() {
        EdrId::ALL.to_vec()
    } else {
        requested_ids
            .iter()
            .filter_map(|id| EdrId::from_id(&id.to_utf8()))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Async task wiring
// ---------------------------------------------------------------------------

struct EdrDetectionTask {
    requested: Vec<EdrId>,
    callback: ThreadPtrHandle<nsIEdrCheckerCallback>,
    // Filled in on the background thread by `run`, consumed on the originating
    // thread by `done`.
    result: Mutex<Vec<&'static str>>,
}

impl Task for EdrDetectionTask {
    fn run(&self) {
        let detected = detect_present_edrs(&self.requested);
        *self.result.lock().unwrap() = detected;
    }

    fn done(&self) -> Result<(), nsresult> {
        // `done` runs on the thread that dispatched the task (the main thread),
        // which is the thread that owns the callback.
        let callback = self.callback.get().ok_or(NS_ERROR_FAILURE)?;
        let detected = std::mem::take(&mut *self.result.lock().unwrap());
        let present: ThinVec<nsCString> = detected.into_iter().map(nsCString::from).collect();
        let _ = unsafe { callback.OnComplete(&present) };
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// XPCOM glue
// ---------------------------------------------------------------------------

#[xpcom(implement(nsIEdrChecker), atomic)]
pub struct EdrCheckerXPCOM {}

#[allow(non_snake_case)]
impl EdrCheckerXPCOM {
    pub fn new() -> RefPtr<EdrCheckerXPCOM> {
        EdrCheckerXPCOM::allocate(InitEdrCheckerXPCOM {})
    }

    fn GetPresentEdrs(
        &self,
        requested_ids: *const ThinVec<nsCString>,
        callback: *const nsIEdrCheckerCallback,
    ) -> nsresult {
        if requested_ids.is_null() || callback.is_null() {
            return NS_ERROR_NULL_POINTER;
        }
        let requested_ids = unsafe { &*requested_ids };
        let callback = unsafe { &*callback };

        let requested = resolve_requested(requested_ids);

        // Hold the callback so it can be invoked back on this (the main) thread
        // once detection completes.
        let callback =
            match ThreadPtrHolder::new(cstr!("nsIEdrCheckerCallback"), RefPtr::new(callback)) {
                Ok(handle) => handle,
                Err(rv) => return rv,
            };

        let task = Box::new(EdrDetectionTask {
            requested,
            callback,
            result: Mutex::new(Vec::new()),
        });

        let runnable = match TaskRunnable::new("EdrChecker::getPresentEdrs", task) {
            Ok(runnable) => runnable,
            Err(rv) => return rv,
        };

        // Detection enumerates processes and queries services, so let the
        // background pool know it may block.
        match runnable
            .dispatch_background_task_with_options(DispatchOptions::default().may_block(true))
        {
            Ok(()) => NS_OK,
            Err(rv) => rv,
        }
    }
}

#[no_mangle]
pub extern "C" fn edr_checker_constructor(
    iid: &xpcom::nsIID,
    result: *mut *mut xpcom::reexports::libc::c_void,
) -> nsresult {
    let obj = EdrCheckerXPCOM::new();
    unsafe { obj.QueryInterface(iid, result) }
}
