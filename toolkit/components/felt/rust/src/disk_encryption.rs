/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::sync::Mutex;
use std::time::{Duration, Instant};

use moz_task::{DispatchOptions, Task, TaskRunnable, ThreadPtrHandle, ThreadPtrHolder};
use nserror::{nsresult, NS_ERROR_NOT_AVAILABLE, NS_ERROR_NOT_SAME_THREAD, NS_OK};
use nsstring::nsCString;
use xpcom::interfaces::nsIDiskEncryptionCheckerCallback;
use xpcom::{xpcom_method, RefPtr};

#[cfg(target_os = "linux")]
use crate::disk_encryption_linux as platform;
#[cfg(target_os = "macos")]
use crate::disk_encryption_macos as platform;
#[cfg(target_os = "windows")]
use crate::disk_encryption_win as platform;

/// Encryption state of one volume.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VolumeState {
    Encrypted,
    EncryptedUnverified,
    Unencrypted,
    /// Encryption or decryption is in progress.
    Converting,
    Unknown,
}

/// Aggregated state reported to the console.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EncryptionStatus {
    Full,
    Enabled,
    Partial,
    Disabled,
    InProgress,
    Unknown,
}

impl EncryptionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            EncryptionStatus::Full => "full",
            EncryptionStatus::Enabled => "enabled",
            EncryptionStatus::Partial => "partial",
            EncryptionStatus::Disabled => "disabled",
            EncryptionStatus::InProgress => "in-progress",
            EncryptionStatus::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct DiskEncryption {
    pub status: EncryptionStatus,
    /// Platform mechanism checked, including for negative results.
    pub method: Option<&'static str>,
}

impl DiskEncryption {
    pub fn unknown() -> DiskEncryption {
        DiskEncryption {
            status: EncryptionStatus::Unknown,
            method: None,
        }
    }
}

/// Aggregates the boot volume and other mounted fixed volumes. `None` means the
/// backend could not enumerate all other volumes.
pub(crate) fn aggregate(boot: VolumeState, others: Option<&[VolumeState]>) -> EncryptionStatus {
    match boot {
        VolumeState::Unknown => EncryptionStatus::Unknown,
        VolumeState::Converting => EncryptionStatus::InProgress,
        VolumeState::Unencrypted => EncryptionStatus::Disabled,
        VolumeState::Encrypted | VolumeState::EncryptedUnverified => match others {
            Some(states) if states.contains(&VolumeState::Unencrypted) => EncryptionStatus::Partial,
            Some(states) if states.contains(&VolumeState::Converting) => {
                EncryptionStatus::InProgress
            }
            None => EncryptionStatus::Enabled,
            Some(states)
                if boot == VolumeState::EncryptedUnverified
                    || states.iter().any(|state| {
                        matches!(
                            state,
                            VolumeState::Unknown | VolumeState::EncryptedUnverified
                        )
                    }) =>
            {
                EncryptionStatus::Enabled
            }
            Some(_) => EncryptionStatus::Full,
        },
    }
}

pub(crate) fn summarize(
    boot: VolumeState,
    others: Option<&[VolumeState]>,
    method: &'static str,
) -> DiskEncryption {
    let status = aggregate(boot, others);
    DiskEncryption {
        status,
        method: (status != EncryptionStatus::Unknown).then_some(method),
    }
}

// Cache stable results to avoid repeating expensive probes on every poll.
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);

// Retry inconclusive and transitional results sooner.
const UNKNOWN_CACHE_TTL: Duration = Duration::from_secs(60);

// Backends stop between probes after this budget. One platform call may still
// block longer. Keep this below the JS timeout.
const SWEEP_BUDGET: Duration = Duration::from_secs(20);

static CACHE: Mutex<Option<(Instant, DiskEncryption)>> = Mutex::new(None);

// A sweep older than this is assumed wedged in an unbounded platform call (a
// Windows shell property read can block indefinitely). Later callers then fail
// immediately, reporting unknown, instead of queueing behind it forever.
const WEDGED_SWEEP_TIMEOUT: Duration = Duration::from_secs(60);

const MAX_WAITING_CALLBACKS: usize = 64;

/// The running sweep and the main-thread callbacks awaiting its result.
struct Sweep {
    started: Instant,
    waiting: Vec<ThreadPtrHandle<nsIDiskEncryptionCheckerCallback>>,
}

static SWEEP: Mutex<Option<Sweep>> = Mutex::new(None);

fn cache_is_usable(cache: &Option<(Instant, DiskEncryption)>, now: Instant) -> bool {
    match cache {
        Some((at, result)) => {
            let ttl = if matches!(
                result.status,
                EncryptionStatus::Enabled
                    | EncryptionStatus::InProgress
                    | EncryptionStatus::Unknown
            ) {
                UNKNOWN_CACHE_TTL
            } else {
                CACHE_TTL
            };
            now.duration_since(*at) < ttl
        }
        None => false,
    }
}

/// Determines the machine's disk encryption status. Runs on a background
/// thread; must not touch main-thread-only state.
fn detect_disk_encryption() -> DiskEncryption {
    {
        // Continue detection after a poisoned cache lock.
        let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if cache_is_usable(&cache, Instant::now()) {
            if let Some((_, result)) = *cache {
                return result;
            }
        }
    }

    // Start the TTL after detection completes.
    let result = platform::detect(Instant::now() + SWEEP_BUDGET);
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), result));
    result
}

struct DiskEncryptionTask {
    // Written by `run` on the worker; read by `done` on the dispatching thread.
    result: Mutex<DiskEncryption>,
}

impl Task for DiskEncryptionTask {
    fn run(&self) {
        *self.result.lock().unwrap() = detect_disk_encryption();
    }

    fn done(&self) -> Result<(), nsresult> {
        let result = *self.result.lock().unwrap();
        let status = nsCString::from(result.status.as_str());
        let method = nsCString::from(result.method.unwrap_or(""));

        let sweep = SWEEP.lock().unwrap_or_else(|e| e.into_inner()).take();
        for handle in sweep.into_iter().flat_map(|sweep| sweep.waiting) {
            if let Some(callback) = handle.get() {
                let _ = unsafe { callback.OnComplete(&*status, &*method) };
            }
        }
        Ok(())
    }
}

#[xpcom(implement(nsIDiskEncryptionChecker), atomic)]
pub struct DiskEncryptionCheckerXPCOM {}

#[allow(non_snake_case)]
impl DiskEncryptionCheckerXPCOM {
    pub fn new() -> RefPtr<DiskEncryptionCheckerXPCOM> {
        DiskEncryptionCheckerXPCOM::allocate(InitDiskEncryptionCheckerXPCOM {})
    }

    xpcom_method!(
        get_disk_encryption => GetDiskEncryption(
            callback: *const nsIDiskEncryptionCheckerCallback
        )
    );

    fn get_disk_encryption(
        &self,
        callback: &nsIDiskEncryptionCheckerCallback,
    ) -> Result<(), nsresult> {
        // `done` invokes every queued callback on the dispatching thread.
        if !moz_task::is_main_thread() {
            return Err(NS_ERROR_NOT_SAME_THREAD);
        }

        let callback = ThreadPtrHolder::new(
            cstr!("nsIDiskEncryptionCheckerCallback"),
            RefPtr::new(callback),
        )?;

        let mut sweep = SWEEP.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(running) = sweep.as_mut() {
            if running.started.elapsed() >= WEDGED_SWEEP_TIMEOUT {
                return Err(NS_ERROR_NOT_AVAILABLE);
            }
            if running.waiting.len() >= MAX_WAITING_CALLBACKS {
                return Err(NS_ERROR_NOT_AVAILABLE);
            }
            running.waiting.push(callback);
            return Ok(());
        }
        *sweep = Some(Sweep {
            started: Instant::now(),
            waiting: vec![callback],
        });
        drop(sweep);

        // Platform detection performs blocking I/O.
        let dispatch = || -> Result<(), nsresult> {
            let task = Box::new(DiskEncryptionTask {
                result: Mutex::new(DiskEncryption::unknown()),
            });
            TaskRunnable::new("DiskEncryptionChecker::getDiskEncryption", task)?
                .dispatch_background_task_with_options(DispatchOptions::default().may_block(true))
        };

        dispatch().inspect_err(|_| {
            // No task will drain the queue after dispatch fails.
            *SWEEP.lock().unwrap_or_else(|e| e.into_inner()) = None;
        })
    }
}

#[no_mangle]
pub extern "C" fn disk_encryption_checker_constructor(
    iid: &xpcom::nsIID,
    result: *mut *mut xpcom::reexports::libc::c_void,
) -> nsresult {
    let obj = DiskEncryptionCheckerXPCOM::new();
    unsafe { obj.QueryInterface(iid, result) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_volume_decides_the_status() {
        assert_eq!(
            aggregate(VolumeState::Unknown, Some(&[VolumeState::Encrypted])),
            EncryptionStatus::Unknown
        );
        assert_eq!(
            aggregate(VolumeState::Converting, Some(&[])),
            EncryptionStatus::InProgress
        );
        assert_eq!(
            aggregate(VolumeState::Encrypted, Some(&[])),
            EncryptionStatus::Full
        );

        assert_eq!(
            aggregate(VolumeState::Unencrypted, Some(&[VolumeState::Encrypted])),
            EncryptionStatus::Disabled
        );
    }

    #[test]
    fn a_known_unencrypted_volume_makes_the_machine_partial() {
        assert_eq!(
            aggregate(
                VolumeState::Encrypted,
                Some(&[VolumeState::Encrypted, VolumeState::Unencrypted])
            ),
            EncryptionStatus::Partial
        );
    }

    #[test]
    fn an_unknown_secondary_volume_preserves_enabled_status() {
        assert_eq!(
            aggregate(VolumeState::Encrypted, Some(&[VolumeState::Unknown])),
            EncryptionStatus::Enabled
        );
    }

    #[test]
    fn an_unattested_encryption_mapping_is_enabled() {
        assert_eq!(
            aggregate(VolumeState::EncryptedUnverified, Some(&[])),
            EncryptionStatus::Enabled
        );
    }

    #[test]
    fn a_converting_volume_makes_the_machine_in_progress() {
        assert_eq!(
            aggregate(
                VolumeState::Encrypted,
                Some(&[VolumeState::Encrypted, VolumeState::Converting])
            ),
            EncryptionStatus::InProgress
        );

        // A known unencrypted volume takes precedence over conversion.
        assert_eq!(
            aggregate(
                VolumeState::Encrypted,
                Some(&[VolumeState::Converting, VolumeState::Unencrypted])
            ),
            EncryptionStatus::Partial
        );
    }

    #[test]
    fn a_plaintext_secondary_takes_precedence_over_a_converting_one() {
        assert_eq!(
            aggregate(
                VolumeState::Encrypted,
                Some(&[VolumeState::Converting, VolumeState::Unencrypted])
            ),
            EncryptionStatus::Partial
        );
    }

    #[test]
    fn incomplete_enumeration_respects_boot_status() {
        assert_eq!(
            aggregate(VolumeState::Encrypted, None),
            EncryptionStatus::Enabled
        );

        assert_eq!(
            aggregate(VolumeState::Unencrypted, None),
            EncryptionStatus::Disabled
        );
        assert_eq!(
            aggregate(VolumeState::Converting, None),
            EncryptionStatus::InProgress
        );
    }

    #[test]
    fn summarize_sets_status_and_method() {
        let known = summarize(VolumeState::Encrypted, Some(&[]), "filevault");
        assert_eq!(known.status, EncryptionStatus::Full);
        assert_eq!(known.method, Some("filevault"));

        let disabled = summarize(VolumeState::Unencrypted, Some(&[]), "bitlocker");
        assert_eq!(disabled.status, EncryptionStatus::Disabled);
        assert_eq!(disabled.method, Some("bitlocker"));

        let unknown = summarize(VolumeState::Unknown, Some(&[]), "dm-crypt");
        assert_eq!(unknown.status, EncryptionStatus::Unknown);
        assert_eq!(unknown.method, None);
    }

    #[test]
    fn cache_expires_sooner_when_inconclusive() {
        let now = Instant::now();

        assert!(!cache_is_usable(&None, now));

        let full = Some((
            now,
            DiskEncryption {
                status: EncryptionStatus::Full,
                method: Some("filevault"),
            },
        ));
        assert!(cache_is_usable(&full, now));

        let just_past_unknown_ttl = now + UNKNOWN_CACHE_TTL + Duration::from_secs(1);
        assert!(cache_is_usable(&full, just_past_unknown_ttl));
        assert!(!cache_is_usable(
            &full,
            now + CACHE_TTL + Duration::from_secs(1)
        ));

        let enabled = Some((
            now,
            DiskEncryption {
                status: EncryptionStatus::Enabled,
                method: Some("dm-crypt"),
            },
        ));
        assert!(cache_is_usable(&enabled, now));
        assert!(!cache_is_usable(&enabled, just_past_unknown_ttl));

        let in_progress = Some((
            now,
            DiskEncryption {
                status: EncryptionStatus::InProgress,
                method: Some("bitlocker"),
            },
        ));
        assert!(cache_is_usable(&in_progress, now));
        assert!(!cache_is_usable(&in_progress, just_past_unknown_ttl));

        let unknown = Some((now, DiskEncryption::unknown()));
        assert!(cache_is_usable(&unknown, now));
        assert!(!cache_is_usable(&unknown, just_past_unknown_ttl));
    }
}
