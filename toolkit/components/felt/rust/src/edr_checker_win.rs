/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use log::trace;
use std::process::Command;

use crate::edr_checker::DetectMethod;

pub fn detect(app_id: &str, method: &DetectMethod) -> bool {
    match method {
        DetectMethod::WindowsService { service_name } => check_windows_service(app_id, service_name),
        DetectMethod::ProcessName { exe_name } => check_process_name(app_id, exe_name),
        DetectMethod::ProcessPath { path_prefixes } => check_process_path(app_id, path_prefixes),
    }
}

fn check_windows_service(app_id: &str, service_name: &str) -> bool {
    let output = match Command::new("sc")
        .args(["query", service_name])
        .stderr(std::process::Stdio::null())
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            trace!("EdrChecker: sc query failed: {}", e);
            return false;
        }
    };

    if let Ok(stdout) = std::str::from_utf8(&output.stdout) {
        for line in stdout.lines() {
            if line.contains("STATE") && line.contains("RUNNING") {
                trace!("EdrChecker: found {} via service {}", app_id, service_name);
                return true;
            }
        }
    }

    false
}

fn check_process_path(app_id: &str, path_prefixes: &[&str]) -> bool {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::psapi::GetModuleFileNameExW;
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == winapi::um::handleapi::INVALID_HANDLE_VALUE {
        trace!("EdrChecker: CreateToolhelp32Snapshot failed");
        return false;
    }

    let mut pe: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut found = false;

    if unsafe { Process32FirstW(snapshot, &mut pe) } != 0 {
        loop {
            let proc_handle = unsafe {
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pe.th32ProcessID)
            };

            if !proc_handle.is_null() {
                let mut full_path = [0u16; 1024];
                let path_len = unsafe {
                    GetModuleFileNameExW(
                        proc_handle,
                        std::ptr::null_mut(),
                        full_path.as_mut_ptr(),
                        full_path.len() as u32,
                    )
                };
                unsafe { CloseHandle(proc_handle) };

                if path_len > 0 {
                    let path_os = OsString::from_wide(&full_path[..path_len as usize]);
                    if let Some(path_str) = path_os.to_str() {
                        if path_prefixes.iter().any(|pfx| {
                            path_str
                                .to_ascii_lowercase()
                                .starts_with(&pfx.to_ascii_lowercase())
                        }) {
                            trace!(
                                "EdrChecker: found {} (pid {}, path {})",
                                app_id, pe.th32ProcessID, path_str
                            );
                            found = true;
                            break;
                        }
                    }
                }
            }

            if unsafe { Process32NextW(snapshot, &mut pe) } == 0 {
                break;
            }
        }
    }

    unsafe { CloseHandle(snapshot) };
    found
}

fn check_process_name(app_id: &str, exe_name: &str) -> bool {
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == winapi::um::handleapi::INVALID_HANDLE_VALUE {
        return false;
    }

    let mut pe: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    let mut found = false;

    if unsafe { Process32FirstW(snapshot, &mut pe) } != 0 {
        loop {
            let proc_name_len = pe
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(pe.szExeFile.len());
            let proc_name = String::from_utf16_lossy(&pe.szExeFile[..proc_name_len]);

            if proc_name.eq_ignore_ascii_case(exe_name) {
                trace!("EdrChecker: found {} via process name {}", app_id, exe_name);
                found = true;
                break;
            }

            if unsafe { Process32NextW(snapshot, &mut pe) } == 0 {
                break;
            }
        }
    }

    unsafe { CloseHandle(snapshot) };
    found
}
