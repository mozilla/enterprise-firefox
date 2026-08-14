/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Static library backing `msixcomserver.dll`, the packaged (MSIX) build's
//! host DLL for MSIX-specific COM servers.
//!
//! The DLL entry point (`DllMain`) is provided by the C++ shim in
//! `../msixcomserver` that links this library. The exported `DllGetClassObject`
//! and `DllCanUnloadNow` symbols live here and are re-exported from the DLL by
//! `msixcomserver.def`.

use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI32, Ordering};

use windows::ApplicationModel::Background::{
    IBackgroundTask, IBackgroundTaskInstance, IBackgroundTask_Impl,
};
use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_INVALIDARG, HMODULE, MAX_PATH, S_FALSE,
    S_OK,
};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows::Win32::System::LibraryLoader::{
    GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
};
use windows::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB;
use windows_core::{
    implement, IUnknown, Interface, Ref, Result as WindowsResult, BOOL, GUID, HRESULT, PCWSTR,
};

/// CLSID Windows activates when a registered TimeTrigger fires. Keep this
/// literal synchronized with the `MOZ_BACKGROUNDTASK_CLSID` config in
/// `toolkit/moz.configure`. We should be able to use try_from(MOZ_BACKGROUNDTASK_CLSID).expect(...)
/// once const_convert is stabalized (github.com/rust-lang/rust/issues/143773)
const CLSID_BACKGROUND_TASK_SERVER: GUID = GUID::from_u128(0x85013aea_4a5a_4b6a_94b8_55090116061e);

/// Number of live COM objects plus outstanding server locks. Windows may call
/// `DllCanUnloadNow` to decide whether to unload this DLL; it must stay loaded
/// while this count is non-zero.
static LOCK_COUNT: AtomicI32 = AtomicI32::new(0);

fn lock_module() {
    LOCK_COUNT.fetch_add(1, Ordering::Relaxed);
}

fn unlock_module() {
    LOCK_COUNT.fetch_sub(1, Ordering::Release);
}

#[implement(IBackgroundTask)]
struct FirefoxBackgroundTask;

impl FirefoxBackgroundTask {
    fn new() -> Self {
        lock_module();
        FirefoxBackgroundTask
    }
}

impl Drop for FirefoxBackgroundTask {
    fn drop(&mut self) {
        unlock_module();
    }
}

impl IBackgroundTask_Impl for FirefoxBackgroundTask_Impl {
    fn Run(&self, task_instance: Ref<IBackgroundTaskInstance>) -> WindowsResult<()> {
        let Some(instance) = task_instance.as_ref() else {
            return Ok(());
        };

        let name = instance.Task()?.Name()?.to_string();
        if !name.is_empty() {
            launch_background_task(&name);
        }

        Ok(())
    }
}

fn launch_background_task(task_name: &str) {
    let Some(install_dir) = dll_directory() else {
        return;
    };

    let firefox = install_dir.join(format!("{}.exe", mozbuild::config::MOZ_APP_NAME));

    // The registration name encodes the launch command line as colon-separated
    // segments: the first is the `--backgroundtask` name, any remaining segments
    // are extra arguments. For example "defaultagent:do-task" launches
    // `firefox --backgroundtask defaultagent do-task`.
    let mut args = vec!["--backgroundtask".to_string()];
    args.extend(task_name.split(':').map(str::to_string));

    let spawn = |flags: u32| {
        std::process::Command::new(&firefox)
            .args(&args)
            .creation_flags(flags)
            .spawn()
    };

    // Break away from the surrogate host's job object so the launched process
    // outlives this short-lived COM server. Some job objects forbid breakaway;
    // fall back to spawning in-job when that happens.
    if spawn(CREATE_BREAKAWAY_FROM_JOB.0).is_err() {
        let _ = spawn(0);
    }
}

/// The directory containing this DLL, which also contains `firefox.exe`.
fn dll_directory() -> Option<PathBuf> {
    let module = current_module()?;

    let mut buffer = vec![0u16; MAX_PATH as usize];
    loop {
        // SAFETY: `module` is a valid handle and `buffer` is a valid, sized
        // buffer for the call to write into.
        let length = unsafe { GetModuleFileNameW(Some(module), &mut buffer) } as usize;
        if length == 0 {
            return None;
        }

        if length < buffer.len() {
            let dll_path = PathBuf::from(String::from_utf16_lossy(&buffer[..length]));
            return dll_path.parent().map(PathBuf::from);
        }
        buffer.resize(buffer.len() * 2, 0);
    }
}

/// Returns the handle of the DLL this code lives in. The handle is not
/// reference-counted.
fn current_module() -> Option<HMODULE> {
    let mut module = HMODULE::default();
    // UNCHANGED_REFCOUNT: we're querying our own DLL, which can't unload while
    // its code is running, so there's no need to hold a reference.
    // SAFETY: `&LOCK_COUNT` is a valid address inside this module and `module`
    // is a valid out-pointer.
    unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            PCWSTR(&LOCK_COUNT as *const AtomicI32 as *const u16),
            &mut module,
        )
    }
    .ok()?;
    Some(module)
}

#[implement(IClassFactory)]
struct BackgroundTaskFactory;

impl IClassFactory_Impl for BackgroundTaskFactory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<IUnknown>,
        iid: *const GUID,
        object: *mut *mut c_void,
    ) -> WindowsResult<()> {
        if !outer.is_null() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }

        let task: IBackgroundTask = FirefoxBackgroundTask::new().into();

        // SAFETY: `iid` and `object` are supplied by the COM runtime.
        unsafe { task.query(iid, object) }.ok()
    }

    fn LockServer(&self, lock: BOOL) -> WindowsResult<()> {
        if lock.as_bool() {
            lock_module();
        } else {
            unlock_module();
        }
        Ok(())
    }
}

/// COM in-process server entry point. Windows (via the MSIX SurrogateServer
/// host) calls this to obtain the class factory for our background task CLSID.
/// This symbol is re-exported from the DLL by `msixcomserver.def`.
///
/// On success returns `S_OK` and stores the requested interface in `ppv`. On
/// failure returns an error [`HRESULT`] (`E_INVALIDARG`, `CLASS_E_CLASSNOTAVAILABLE`,
/// or an interface query failure) and leaves `*ppv` null. See the [MSDN
/// documentation] for the exact contract.
///
/// [MSDN documentation]: https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-dllgetclassobject#return-value
///
/// # Safety
///
/// Each of `rclsid`, `riid`, and `ppv` must be either null or a valid pointer;
/// `ppv` must point to storage this function may write the returned interface
/// into.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: Option<&GUID>,
    riid: Option<&GUID>,
    ppv: Option<&mut *mut c_void>,
) -> HRESULT {
    let (Some(rclsid), Some(riid), Some(ppv)) = (rclsid, riid, ppv) else {
        return E_INVALIDARG;
    };

    // DllGetClassObject must clear the out-pointer before returning.
    *ppv = std::ptr::null_mut();

    if *rclsid != CLSID_BACKGROUND_TASK_SERVER {
        return CLASS_E_CLASSNOTAVAILABLE;
    }

    let factory: IClassFactory = BackgroundTaskFactory.into();

    // SAFETY: `riid` and `ppv` are valid per the checks above.
    unsafe { factory.query(riid, ppv) }
}

/// COM in-process server unload check. Windows (via the MSIX SurrogateServer
/// host) calls this to learn whether the DLL can be unloaded: `S_OK` when no
/// COM objects are alive and no server locks are held, otherwise `S_FALSE`.
/// This symbol is re-exported from the DLL by `msixcomserver.def`.
#[unsafe(no_mangle)]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    if LOCK_COUNT.load(Ordering::Acquire) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}
