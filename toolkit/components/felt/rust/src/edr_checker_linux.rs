/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use log::trace;
use std::cell::OnceCell;
use std::path::Path;

use crate::edr_checker::{run_command_bounded, DetectMethod};

/// A one-time capture of the system state used to evaluate every requested
/// agent without re-walking `/proc` per agent/method. The process table is
/// walked lazily, since most agents are detected via services or install
/// directories and never need it.
pub struct Snapshot {
    /// Executable paths (`/proc/<pid>/exe` targets) of all running processes.
    process_paths: OnceCell<Vec<String>>,
}

impl Snapshot {
    pub fn capture() -> Snapshot {
        Snapshot {
            process_paths: OnceCell::new(),
        }
    }

    pub fn matches(&self, app_id: &str, method: &DetectMethod) -> bool {
        match method {
            DetectMethod::ProcessPath { path_prefixes } => {
                let paths = self.process_paths.get_or_init(enumerate_proc_exe_paths);
                let found = paths
                    .iter()
                    .any(|path| path_prefixes.iter().any(|pfx| path.starts_with(pfx)));
                if found {
                    trace!("EdrChecker: found {} via process path", app_id);
                }
                found
            }
            DetectMethod::DirExists { path } => check_dir_exists(app_id, path),
            DetectMethod::Service { name } => check_service(app_id, name),
        }
    }
}

/// Checks whether a service is active. There is no dependency-free native API
/// for querying init systems, so this shells out; it is the fallback after the
/// native filesystem/process checks above. We probe systemd, SysVInit, and
/// OpenRC in turn, skipping any whose tool is not installed.
fn check_service(app_id: &str, name: &str) -> bool {
    if let Some(true) = try_systemctl(name) {
        trace!("EdrChecker: found {} via systemctl {}", app_id, name);
        return true;
    }
    if let Some(true) = try_sysvinit(name) {
        trace!("EdrChecker: found {} via service {}", app_id, name);
        return true;
    }
    if let Some(true) = try_openrc(name) {
        trace!("EdrChecker: found {} via rc-service {}", app_id, name);
        return true;
    }
    false
}

// Each `try_*` returns `None` when the relevant tool is not installed (so the
// caller moves on to the next init system) or `Some(active?)` otherwise. We
// detect "not installed" from the spawn error rather than shelling out to
// `which`, avoiding an extra subprocess.

fn try_systemctl(name: &str) -> Option<bool> {
    run_status_command("systemctl", &["is-active", "--quiet", name])
}

fn try_sysvinit(name: &str) -> Option<bool> {
    run_status_command("service", &[name, "status"])
}

fn try_openrc(name: &str) -> Option<bool> {
    run_status_command("rc-service", &[name, "status"])
}

/// Runs `program args...`. Returns `None` if the program could not be launched
/// (e.g. not installed) or did not answer within PROBE_TIMEOUT, otherwise
/// `Some(exit success)`. A timed-out probe is treated as `None` so the caller
/// moves on to the next init system; the probe's process is killed rather than
/// left running (see run_command_bounded).
fn run_status_command(program: &str, args: &[&str]) -> Option<bool> {
    run_command_bounded(program, args).map(|output| output.status.success())
}

fn enumerate_proc_exe_paths() -> Vec<String> {
    use std::fs;

    let mut paths = Vec::new();
    let proc_dir = match fs::read_dir("/proc") {
        Ok(d) => d,
        Err(_) => {
            trace!("EdrChecker: failed to open /proc");
            return paths;
        }
    };

    for entry in proc_dir.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if !name_str.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }

        let exe_link = Path::new("/proc").join(&name).join("exe");
        if let Ok(exe_path) = fs::read_link(&exe_link) {
            if let Some(exe_str) = exe_path.to_str() {
                paths.push(exe_str.to_string());
            }
        }
    }

    paths
}

fn check_dir_exists(app_id: &str, path: &str) -> bool {
    if Path::new(path).is_dir() {
        trace!("EdrChecker: found {} via directory {}", app_id, path);
        return true;
    }
    false
}
