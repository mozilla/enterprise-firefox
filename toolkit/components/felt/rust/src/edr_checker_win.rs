/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use log::trace;
use std::cell::OnceCell;

use crate::edr_checker::{run_command_bounded, DetectMethod};

/// Lower-cased full paths and executable file names of all running processes.
struct ProcessList {
    paths: Vec<String>,
    names: Vec<String>,
}

/// A one-time capture of the system state used to evaluate every requested
/// agent without re-enumerating per agent/method. The process table is
/// enumerated lazily, since many agents are detected purely via the Service
/// Control Manager and never need it.
pub struct Snapshot {
    processes: OnceCell<ProcessList>,
}

impl Snapshot {
    pub fn capture() -> Snapshot {
        Snapshot {
            processes: OnceCell::new(),
        }
    }

    fn processes(&self) -> &ProcessList {
        self.processes.get_or_init(|| {
            let (paths, names) = enumerate_processes();
            ProcessList { paths, names }
        })
    }

    pub fn matches(&self, app_id: &str, method: &DetectMethod) -> bool {
        match method {
            DetectMethod::WindowsService { service_name } => {
                check_windows_service(app_id, service_name)
            }
            DetectMethod::ProcessName { exe_name } => {
                let target = exe_name.to_ascii_lowercase();
                let found = self.processes().names.iter().any(|name| *name == target);
                if found {
                    trace!("EdrChecker: found {} via process name {}", app_id, exe_name);
                }
                found
            }
            DetectMethod::ProcessPath { path_prefixes } => {
                let prefixes: Vec<String> = path_prefixes
                    .iter()
                    .map(|p| p.to_ascii_lowercase())
                    .collect();
                let found = self
                    .processes()
                    .paths
                    .iter()
                    .any(|path| prefixes.iter().any(|pfx| path.starts_with(pfx)));
                if found {
                    trace!("EdrChecker: found {} via process path", app_id);
                }
                found
            }
        }
    }
}

/// Determines whether a Windows service is running. Prefers the Service
/// Control Manager API (locale-independent, no subprocess); falls back to the
/// `sc` command only when the SCM result is inconclusive.
fn check_windows_service(app_id: &str, service_name: &str) -> bool {
    match query_service_running_scm(service_name) {
        Some(running) => {
            if running {
                trace!(
                    "EdrChecker: found {} via SCM service {}",
                    app_id,
                    service_name
                );
            }
            running
        }
        None => check_windows_service_sc(app_id, service_name),
    }
}

/// Queries the Service Control Manager for a service's run state.
///
/// Returns `Some(true)`/`Some(false)` for a definitive answer (including
/// "service does not exist" -> not running), or `None` if the query was
/// inconclusive (e.g. the SCM could not be opened or access was denied), so
/// the caller can fall back to another mechanism.
fn query_service_running_scm(service_name: &str) -> Option<bool> {
    use std::ptr::null_mut;
    use winapi::shared::winerror::ERROR_SERVICE_DOES_NOT_EXIST;
    use winapi::um::errhandlingapi::GetLastError;
    use winapi::um::winsvc::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatusEx, SC_MANAGER_CONNECT,
        SC_STATUS_PROCESS_INFO, SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_STATUS_PROCESS,
    };

    // Connect to the local machine's active services database.
    let scm = unsafe { OpenSCManagerW(null_mut(), null_mut(), SC_MANAGER_CONNECT) };
    if scm.is_null() {
        trace!("EdrChecker: OpenSCManagerW failed");
        return None;
    }

    let wide_name: Vec<u16> = service_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let service = unsafe { OpenServiceW(scm, wide_name.as_ptr(), SERVICE_QUERY_STATUS) };
    if service.is_null() {
        let err = unsafe { GetLastError() };
        unsafe { CloseServiceHandle(scm) };
        // A missing service is a definitive "not running"; anything else (e.g.
        // access denied) is inconclusive, so fall back.
        return if err == ERROR_SERVICE_DOES_NOT_EXIST {
            Some(false)
        } else {
            None
        };
    }

    let mut status: SERVICE_STATUS_PROCESS = unsafe { std::mem::zeroed() };
    let mut bytes_needed: u32 = 0;
    let ok = unsafe {
        QueryServiceStatusEx(
            service,
            SC_STATUS_PROCESS_INFO,
            &mut status as *mut SERVICE_STATUS_PROCESS as *mut u8,
            std::mem::size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut bytes_needed,
        )
    };
    unsafe {
        CloseServiceHandle(service);
        CloseServiceHandle(scm);
    }
    if ok == 0 {
        return None;
    }
    Some(status.dwCurrentState == SERVICE_RUNNING)
}

/// Fallback service check via the `sc` command. Note this parses English
/// output ("STATE" / "RUNNING") and is only used when the SCM API is
/// unavailable.
fn check_windows_service_sc(app_id: &str, service_name: &str) -> bool {
    let Some(output) = run_command_bounded("sc", &["query", service_name]) else {
        trace!("EdrChecker: sc query did not complete for {}", service_name);
        return false;
    };

    if let Ok(stdout) = std::str::from_utf8(&output.stdout) {
        for line in stdout.lines() {
            if line.contains("STATE") && line.contains("RUNNING") {
                trace!(
                    "EdrChecker: found {} via sc service {}",
                    app_id,
                    service_name
                );
                return true;
            }
        }
    }

    false
}

/// Enumerates all running processes once, returning their lower-cased full
/// paths and executable file names.
fn enumerate_processes() -> (Vec<String>, Vec<String>) {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use winapi::um::winbase::QueryFullProcessImageNameW;
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;

    let mut paths = Vec::new();
    let mut names = Vec::new();

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        trace!("EdrChecker: CreateToolhelp32Snapshot failed");
        return (paths, names);
    }

    let mut pe: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    if unsafe { Process32FirstW(snapshot, &mut pe) } != 0 {
        loop {
            // Executable file name straight from the snapshot entry.
            let name_len = pe
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(pe.szExeFile.len());
            let name = String::from_utf16_lossy(&pe.szExeFile[..name_len]);
            if !name.is_empty() {
                names.push(name.to_ascii_lowercase());
            }

            // Full path (best-effort; requires opening the process).
            // QueryFullProcessImageNameW is used rather than GetModuleFileNameExW
            // because it only needs PROCESS_QUERY_LIMITED_INFORMATION (which is
            // grantable for more processes) and is the API Microsoft recommends
            // for retrieving a process's executable path.
            let proc_handle =
                unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pe.th32ProcessID) };
            if !proc_handle.is_null() {
                let mut full_path = [0u16; 1024];
                let mut path_len = full_path.len() as u32;
                let ok = unsafe {
                    QueryFullProcessImageNameW(
                        proc_handle,
                        0,
                        full_path.as_mut_ptr(),
                        &mut path_len,
                    )
                };
                unsafe { CloseHandle(proc_handle) };
                if ok != 0 && path_len > 0 {
                    let path_os = OsString::from_wide(&full_path[..path_len as usize]);
                    if let Some(path_str) = path_os.to_str() {
                        paths.push(path_str.to_ascii_lowercase());
                    }
                }
            }

            if unsafe { Process32NextW(snapshot, &mut pe) } == 0 {
                break;
            }
        }
    }

    unsafe { CloseHandle(snapshot) };
    (paths, names)
}
