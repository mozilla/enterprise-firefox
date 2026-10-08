/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use moz_task::{DispatchOptions, Task, TaskRunnable, ThreadPtrHandle, ThreadPtrHolder};
use nserror::{nsresult, NS_ERROR_FAILURE, NS_OK};
use nsstring::nsCString;
use thin_vec::ThinVec;
use xpcom::interfaces::nsIEdrCheckerCallback;
use xpcom::{xpcom_method, RefPtr};

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
    // The complete catalog of known EDR agents.
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

// Detected agents are cached so repeated posture collections do not re-probe.
// Long relative to the console poll interval so one detection serves many
// polls, yet short enough to reflect an agent install/removal in time.
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);

// (captured_at, present? for each agent evaluated in the most recent sweep).
// Guarded by a Mutex because detection runs on a moz_task background thread.
static CACHE: Mutex<Option<(Instant, HashMap<EdrId, bool>)>> = Mutex::new(None);

// Serializes detection sweeps: the console controls the poll interval, so an
// interval shorter than a sweep would otherwise let sweeps stack up, each
// spawning its own probes. A concurrent caller blocks here until the running
// sweep publishes its results, then finds the cache warm.
static DETECTION_LOCK: Mutex<()> = Mutex::new(());

/// Whether the cached sweep can answer `requested` without re-probing: it must
/// be within the TTL and must already contain every requested agent. A sweep
/// only evaluates the agents that were requested at the time, so asking for a
/// previously-unseen agent forces a re-sweep rather than silently reporting it
/// absent.
fn cache_is_usable(
    cache: &Option<(Instant, HashMap<EdrId, bool>)>,
    requested: &[EdrId],
    now: Instant,
) -> bool {
    match cache {
        Some((at, map)) => {
            now.duration_since(*at) < CACHE_TTL && requested.iter().all(|id| map.contains_key(id))
        }
        None => false,
    }
}

/// Determines which of `requested` agents are present, returning their string
/// identifiers. Runs on a background thread; must not touch main-thread-only
/// state.
fn detect_present_edrs(requested: &[EdrId]) -> Vec<&'static str> {
    // Recover a poisoned lock (a panicking probe) so detection is not wedged
    // for the rest of the session.
    let _sweep = DETECTION_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let now = Instant::now();

    let usable = cache_is_usable(
        &CACHE.lock().unwrap_or_else(|e| e.into_inner()),
        requested,
        now,
    );

    if !usable {
        // Evaluate ONLY the requested agents. The console decides which agents
        // to probe, and probing one can shell out (e.g. querying service status
        // on Linux for agents that aren't even installed), so we must not touch
        // agents that were not requested. The snapshot is captured without
        // holding the cache lock, which is taken only briefly to publish. The
        // requested set is console-driven and stable, so this steady-states to
        // one sweep of that set per TTL.
        let snapshot = Snapshot::capture();
        let map: HashMap<EdrId, bool> = requested
            .iter()
            .copied()
            .map(|id| {
                let present = detection_methods(id)
                    .iter()
                    .any(|method| snapshot.matches(id.as_str(), method));
                (id, present)
            })
            .collect();
        *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, map));
    }

    let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let Some((_, map)) = cache.as_ref() else {
        return Vec::new();
    };
    requested
        .iter()
        .filter_map(|&id| {
            map.get(&id)
                .copied()
                .unwrap_or(false)
                .then_some(id.as_str())
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

    xpcom_method!(
        get_present_edrs => GetPresentEdrs(
            requested_ids: *const ThinVec<nsCString>,
            callback: *const nsIEdrCheckerCallback
        )
    );

    fn get_present_edrs(
        &self,
        requested_ids: &ThinVec<nsCString>,
        callback: &nsIEdrCheckerCallback,
    ) -> Result<(), nsresult> {
        let requested = resolve_requested(requested_ids);

        // Hold the callback so it can be invoked back on this (the main) thread
        // once detection completes.
        let callback = ThreadPtrHolder::new(cstr!("nsIEdrCheckerCallback"), RefPtr::new(callback))?;

        let task = Box::new(EdrDetectionTask {
            requested,
            callback,
            result: Mutex::new(Vec::new()),
        });

        let runnable = TaskRunnable::new("EdrChecker::getPresentEdrs", task)?;

        // Detection enumerates processes and queries services, so let the
        // background pool know it may block.
        runnable
            .dispatch_background_task_with_options(DispatchOptions::default().may_block(true))?;

        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_usable_only_when_fresh_and_complete() {
        let now = Instant::now();

        // Nothing cached yet: must sweep.
        assert!(!cache_is_usable(&None, &[EdrId::CrowdStrike], now));

        // Fresh cache that contains the requested agent is usable.
        let mut map = HashMap::new();
        map.insert(EdrId::CrowdStrike, true);
        let fresh = Some((now, map.clone()));
        assert!(cache_is_usable(&fresh, &[EdrId::CrowdStrike], now));

        // Fresh cache missing a newly requested agent forces a re-sweep, so the
        // narrowing never silently reports an unseen agent as absent.
        assert!(!cache_is_usable(
            &fresh,
            &[EdrId::CrowdStrike, EdrId::SentinelOne],
            now
        ));

        // A complete but stale cache is not usable. Age it by advancing the
        // reference time rather than subtracting from `now`, which panics when
        // the monotonic clock has not been running for a whole TTL yet.
        let stale = Some((now, map));
        assert!(!cache_is_usable(
            &stale,
            &[EdrId::CrowdStrike],
            now + CACHE_TTL + Duration::from_secs(1)
        ));
    }
}
