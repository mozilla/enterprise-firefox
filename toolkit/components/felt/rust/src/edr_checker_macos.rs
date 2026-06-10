/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use log::trace;
use std::process::Command;

use crate::edr_checker::DetectMethod;

pub fn detect(app_id: &str, method: &DetectMethod) -> bool {
    match method {
        DetectMethod::ProcessPath { path_prefixes } => check_process_path(app_id, path_prefixes),
        DetectMethod::ProcessName { exe_name } => check_process_name(app_id, exe_name),
        DetectMethod::SystemExtension { identifier } => check_system_extension(app_id, identifier),
    }
}

// Iterates over the executable path of every running process, calling `f`
// with each (pid, path). Returns true as soon as `f` returns true.
fn for_each_process_path<F: FnMut(libc::c_int, &str) -> bool>(mut f: F) -> bool {
    extern "C" {
        fn proc_listallpids(buffer: *mut libc::pid_t, buffersize: libc::c_int) -> libc::c_int;
        fn proc_pidpath(
            pid: libc::c_int,
            buffer: *mut libc::c_char,
            buffersize: u32,
        ) -> libc::c_int;
    }

    const PROC_PIDPATHINFO_MAXSIZE: u32 = 4096;

    let pid_count = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
    if pid_count <= 0 {
        trace!("EdrChecker: proc_listallpids failed");
        return false;
    }

    let mut pids = vec![0i32; pid_count as usize];
    let pid_count = unsafe {
        proc_listallpids(
            pids.as_mut_ptr(),
            (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int,
        )
    };
    if pid_count <= 0 {
        return false;
    }

    let mut path_buf = vec![0u8; PROC_PIDPATHINFO_MAXSIZE as usize];

    for &pid in &pids[..pid_count as usize] {
        if pid <= 0 {
            continue;
        }
        let len = unsafe {
            proc_pidpath(
                pid,
                path_buf.as_mut_ptr() as *mut libc::c_char,
                PROC_PIDPATHINFO_MAXSIZE,
            )
        };
        if len <= 0 {
            continue;
        }

        if let Ok(path_str) = std::str::from_utf8(&path_buf[..len as usize]) {
            if f(pid, path_str) {
                return true;
            }
        }
    }

    false
}

fn check_process_path(app_id: &str, path_prefixes: &[&str]) -> bool {
    for_each_process_path(|pid, path_str| {
        if path_prefixes.iter().any(|pfx| path_str.starts_with(pfx)) {
            trace!("EdrChecker: found {} (pid {}, path {})", app_id, pid, path_str);
            return true;
        }
        false
    })
}

fn check_process_name(app_id: &str, exe_name: &str) -> bool {
    for_each_process_path(|pid, path_str| {
        let base = path_str.rsplit('/').next().unwrap_or(path_str);
        if base.eq_ignore_ascii_case(exe_name) {
            trace!("EdrChecker: found {} (pid {}, process {})", app_id, pid, base);
            return true;
        }
        false
    })
}

fn check_system_extension(app_id: &str, identifier: &str) -> bool {
    let output = match Command::new("systemextensionsctl")
        .arg("list")
        .stderr(std::process::Stdio::null())
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            trace!("EdrChecker: systemextensionsctl failed: {}", e);
            return false;
        }
    };

    if let Ok(stdout) = std::str::from_utf8(&output.stdout) {
        for line in stdout.lines() {
            if line.contains(identifier) && line.to_lowercase().contains("activated enabled") {
                trace!("EdrChecker: found {} via system extension", app_id);
                return true;
            }
        }
    }

    false
}
