/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use log::trace;
use std::cell::OnceCell;

use crate::edr_checker::{run_command_bounded, DetectMethod};

/// A one-time capture of the system state used to evaluate every requested
/// agent without re-enumerating processes (or re-running
/// `systemextensionsctl`) per agent/method.
pub struct Snapshot {
    /// Executable paths of all running processes; enumerated lazily since some
    /// agents are detected purely via system extensions.
    process_paths: OnceCell<Vec<String>>,
    /// Output of `systemextensionsctl list`, fetched at most once and only if
    /// some requested agent is detected via a system extension.
    system_extensions: OnceCell<Option<String>>,
}

impl Snapshot {
    pub fn capture() -> Snapshot {
        Snapshot {
            process_paths: OnceCell::new(),
            system_extensions: OnceCell::new(),
        }
    }

    pub fn matches(&self, app_id: &str, method: &DetectMethod) -> bool {
        match method {
            DetectMethod::ProcessPath { path_prefixes } => {
                let found = self
                    .process_paths()
                    .iter()
                    .any(|path| path_prefixes.iter().any(|pfx| path.starts_with(pfx)));
                if found {
                    trace!("EdrChecker: found {} via process path", app_id);
                }
                found
            }
            DetectMethod::ProcessName { exe_name } => {
                let found = self.process_paths().iter().any(|path| {
                    let base = path.rsplit('/').next().unwrap_or(path.as_str());
                    base.eq_ignore_ascii_case(exe_name)
                });
                if found {
                    trace!("EdrChecker: found {} via process name {}", app_id, exe_name);
                }
                found
            }
            DetectMethod::SystemExtension { identifier } => {
                self.check_system_extension(app_id, identifier)
            }
        }
    }

    fn process_paths(&self) -> &Vec<String> {
        self.process_paths.get_or_init(collect_process_paths)
    }

    fn check_system_extension(&self, app_id: &str, identifier: &str) -> bool {
        let listing = self.system_extensions.get_or_init(fetch_system_extensions);
        let Some(output) = listing else {
            return false;
        };
        for line in output.lines() {
            if line.contains(identifier) && line.to_ascii_lowercase().contains("activated enabled")
            {
                trace!("EdrChecker: found {} via system extension", app_id);
                return true;
            }
        }
        false
    }
}

fn collect_process_paths() -> Vec<String> {
    let mut paths = Vec::new();
    for_each_process_path(|_pid, path_str| {
        paths.push(path_str.to_string());
        false
    });
    paths
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

/// Fetches the system-extension listing. There is no dependency-free native
/// API for this, so it shells out once; the result is cached in the Snapshot.
fn fetch_system_extensions() -> Option<String> {
    let Some(output) = run_command_bounded("systemextensionsctl", &["list"]) else {
        trace!("EdrChecker: systemextensionsctl did not complete");
        return None;
    };
    String::from_utf8(output.stdout).ok()
}
