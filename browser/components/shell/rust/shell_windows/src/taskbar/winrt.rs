/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! # TaskbarManager Pin WinRT API
//!
//! This implements functionality to pin an app to the taskbar using the
//! TaskbarManager WinRT API. This was originally exposed to UWP/MSIX apps, and
//! later extended to unpackaged Win32 apps while locking down the undocumented
//! [IPinnedList3 COM API][crate::taskbar::com].
//!
//! ## Secondary Pinning
//!
//! For unpackaged Win32 applications secondary applications can be pinned to
//! the taskbar by temporarily changing the process AUMID while requesting the
//! application be pinned.
//!
//! This does not work for MSIX applications as the process AUMID is
//! virtualized, and modifying it within the application is not visible to the
//! system. Instead MSIX relies on [Secondary Tiles][crate::secondary_tiles].
//!
//! ## Limited Access Feature
//!
//! This feature initially required the "com.microsoft.windows.taskbar.pin"
//! [Limited Access Feature][crate::limited_access_features] unlocked to work
//! for unpackaged Win32 applications.
//!
//! As of Windows 11 26200 Build 7840 this graduated out of limited access and
//! became generally available.
//!
//! ## Requirements
//!
//! This API requires a shortcut present in the virtual shell:appsfolder
//! directory, i.e. a shortcut with unique AUMID in either the User or Common
//! Start Menu folders. Note that there is a delay between files being created
//! in the Start Menu folders and becoming accessible in shell:appsfolder.
//!
//! Additionally the app must be focused when pinning is requested.

use crate::util::thread::MainThreadGuard;
use nserror::{NS_ERROR_NOT_AVAILABLE, NS_ERROR_UNEXPECTED, nsresult};
use nsstring::{nsAString, nsCString};
use std::sync::LazyLock;
use windows::{ApplicationModel::Package, UI::Shell::TaskbarManager, core::Error as WinError};
use xpcom::{RefPtr, interfaces::nsILimitedAccessFeatureService};

use super::PinResult;
use crate::util::async_timer;

static LAF_LOCK: LazyLock<Result<(), nsresult>> = LazyLock::new(|| {
    let svc: RefPtr<nsILimitedAccessFeatureService> =
        xpcom::create_instance(c"@mozilla.org/limited-access-feature-service;1")
            .ok_or(NS_ERROR_UNEXPECTED)?;

    let mut feature_id = nsCString::new();
    // SAFETY: nsCString points to valid, initialized memory defined above.
    unsafe { svc.GetTaskbarPinFeatureId(&mut *feature_id) }.to_result()?;

    // SAFETY: nsCString points to valid, initialized memory defined above.
    let feature =
        xpcom::getter_addrefs(|p| unsafe { svc.GenerateLimitedAccessFeature(&*feature_id, p) })
            .inspect_err(|_| {
                log::info!("Error generating taskbar pin Limited Access Feature ID. May not be available for this version of Windows or have graduated to no longer being necessary.");
            })?;

    let mut unlocked = false;
    // SAFETY: bool points to valid, initialized memory defined above.
    unsafe { feature.Unlock(&mut unlocked) }.to_result()?;
    if !unlocked {
        Err(NS_ERROR_UNEXPECTED)
    } else {
        Ok(())
    }
});

pub(super) fn is_pinning_allowed() -> bool {
    if let Err(_e) = *LAF_LOCK {
        // Limited Access Feature no longer necessary for Windows 11 26200 Build
        // 7840, and possibly other channels.
        log::info!(
            "Failed to unlock Limited Access Feature, attempting to use Taskbar Pinning API assuming LAF is no longer necessary."
        );
    }

    TaskbarManager::GetDefault()
        .and_then(|m| m.IsPinningAllowed())
        .unwrap_or(false)
}

/// Pins the provided app to the taskbar using the WinRT TaskbarManager API,
/// optionally returning before the pin request has resolved.
pub(super) async fn pin_to_taskbar(
    aumid: &nsAString,
    fire_and_forget: bool,
    // We need to be on a UI thread for taskbar pinning prompt to show.
    _main_guard: MainThreadGuard,
) -> Result<PinResult, nsresult> {
    if let Err(_e) = *LAF_LOCK {
        // Limited Access Feature no longer necessary for Windows 11 26200 Build
        // 7840, and possibly other channels.
        log::info!(
            "Failed to unlock Limited Access Feature, attempting to use Taskbar Pinning API assuming LAF is no longer necessary."
        );
    }

    log::info!("Pinning with AUMID {aumid}");

    // Ideally we would refactor this such that AUMID is only provided in
    // non-MSIX contexts and error when that is violated, and generalize our
    // pinning abstraction to automatically use secondary tile pinning when in
    // an MSIX context. For now we match the behavior adopted from prior
    // implementations.
    let aumid_holder = match Package::Current() {
        Ok(_) => None,
        Err(_) => Some(aumid::Holder::set_aumid(aumid).await?),
    };

    let manager = TaskbarManager::GetDefault().map_err(|e| {
        log::debug!("TaskbarManager not available: {e:?}");
        NS_ERROR_NOT_AVAILABLE
    })?;

    async {
        if xpcom::is_in_automation() {
            // Return early in tests to avoid actually pinning the app. Also
            // forces the AUMID to reset immediately by dropping the AUMID
            // holder instead of moving it into an async to resolve later.
            return Ok(PinResult::Unknown);
        }

        let user_confirmed = manager.RequestPinCurrentAppAsync()?;

        if let Some(aumid_holder) = aumid_holder {
            // Schedule restoring the process AUMID to remove a race between it
            // and processing the pin request using the temporarily set AUMID.
            // This is believed to work due to it hypothetically allowing the
            // main thread's STA Message loop to run first.
            //
            // Note: we don't want to await the pin request before resetting the
            // AUMID. The pin request requires user interaction and is therefore
            // not guaranteed to resolve. We want to restore the AUMID as soon
            // as possible to prevent potential adverse interactions with
            // Windows APIs reliant on the process AUMID. Additionally this
            // livelocks following attempts to pin to the taskbar because we
            // synchronize attempts to change the process AUMID, as might occur
            // when setting up several web apps in succession.
            //
            // If in the future we want to ensure AUMID is safe to reset, we
            // could try inspecting the "App" application's notification history
            // to observe when the pin prompt is shown.
            moz_task::spawn_local("WinRT Pin Defer AUMID Restore", async {
                use std::time::Duration;
                if let Err(e) = async_timer::sleep(Duration::from_millis(100)).await {
                    log::error!("Error delaying before restoring the default AUMID, incorrect app might prompt to pin: {e:?}");
                }

                aumid_holder.restore_aumid();
            })
            .detach();
        }

        if fire_and_forget {
            log::info!("Pin via WinRT with fire and forget ran to end.");
            Ok(PinResult::Unknown)
        } else if user_confirmed.await? {
            log::info!("Pin via WinRT affirmed by user.");
            Ok(PinResult::Pinned)
        } else {
            log::info!("Pin via WinRT rejected by user or system.");
            Ok(PinResult::Rejected)
        }
    }.await.map_err(|e: WinError| {
        log::error!("Error using TaskbarManager API: {e:?}");
        nserror::NS_ERROR_UNEXPECTED
    })
}

mod aumid {
    //! This module provides a scoped override of the current process's
    //! AppUserModelID (AUMID) that orders concurrent overrides and restores the
    //! AUMID on drop.

    use futures::lock::{Mutex, MutexGuard};
    use nserror::{NS_ERROR_UNEXPECTED, nsresult};
    use nsstring::{nsAString, nsString};
    use std::sync::LazyLock;
    use windows::{
        Win32::{
            System::Com::CoTaskMemFree,
            UI::Shell::{
                GetCurrentProcessExplicitAppUserModelID, SetCurrentProcessExplicitAppUserModelID,
            },
        },
        core::{HSTRING, PCWSTR},
    };

    static DEFAULT_AUMID: LazyLock<Result<Mutex<HSTRING>, nsresult>> = LazyLock::new(|| {
        // SAFETY: GetCurrentProcessExplicitAppUserModelID handles pointer
        // safety directly, and should probably be marked safe.
        //
        // PWSTR is only used when GetCurrentProcessExplicitAppUserModelID
        // succeeds therefore is a non-null and valid.
        unsafe {
            GetCurrentProcessExplicitAppUserModelID().map(|aumid| {
                let hstr = aumid.to_hstring();
                CoTaskMemFree(Some(aumid.0 as _));
                Mutex::new(hstr)
            })
        }
        .map_err(|e| {
            log::error!("Failed to retrieve the current process AUMID: {e:?}");
            NS_ERROR_UNEXPECTED
        })
    });

    /// Holder for the AUMID Mutex lock to ensure only one task sets the process
    /// AUMID at a time.
    pub(super) struct Holder<'a> {
        default_aumid_lock: MutexGuard<'a, HSTRING>,
    }

    impl Holder<'_> {
        /// Attempts to acquire a lock to set the current process AUMID, then
        /// set it to the provided AUMID.
        #[must_use]
        pub async fn set_aumid(temp_aumid: &nsAString) -> Result<Self, nsresult> {
            // Block while AUMID is temporarily modified.
            let default_aumid_lock = DEFAULT_AUMID.as_ref().map_err(|e| *e)?.lock().await;
            let original_aumid = &*default_aumid_lock;

            log::info!("Original process AUMID was {original_aumid}, setting it to {temp_aumid}");

            let temp_aumid = nsString::from(temp_aumid);
            // SAFETY: nsString is inherently non-null and null-terminated
            // therefore valid to construct a PCWSTR from to pass to
            // SetCurrentProcessExplicitAppUserModelID.
            unsafe {
                SetCurrentProcessExplicitAppUserModelID(PCWSTR::from_raw(temp_aumid.as_ptr()))
            }
            .map_err(|e| {
                log::error!("Error setting the process AUMID: {e:?}");
                NS_ERROR_UNEXPECTED
            })?;

            Ok(Self { default_aumid_lock })
        }

        /// Drops self to trigger the AUMID to revert to the default and release
        /// the lock to set the default AUMID.
        pub fn restore_aumid(self) {}
    }

    impl Drop for Holder<'_> {
        /// Restore the default AUMID.
        fn drop(&mut self) {
            log::info!("Restoring process AUMID to {:?}", self.default_aumid_lock);
            // SAFETY: HSTRING deref ensures it returns a null-terminated string
            // even when empty, which is a valid parameter for
            // SetCurrentProcessExplicitAppUserModelID.
            if let Err(e) =
                unsafe { SetCurrentProcessExplicitAppUserModelID(&*self.default_aumid_lock) }
            {
                log::error!("Error restoring AUMID: {e:?}");
            }
        }
    }
}
