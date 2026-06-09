/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use log::trace;
use std::path::Path;
use std::process::Command;

use crate::edr_checker::DetectMethod;

pub fn detect(app_id: &str, method: &DetectMethod) -> bool {
    match method {
        DetectMethod::Service { name } => check_service(app_id, name),
        DetectMethod::DirExists { path } => check_dir_exists(app_id, path),
        DetectMethod::ProcessPath { path_prefixes } => check_process_path(app_id, path_prefixes),
    }
}

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

fn try_systemctl(name: &str) -> Option<bool> {
    if !command_exists("systemctl") {
        return None;
    }
    let status = Command::new("systemctl")
        .args(["is-active", "--quiet", name])
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .status()
        .ok()?;
    Some(status.success())
}

fn try_sysvinit(name: &str) -> Option<bool> {
    if !command_exists("service") {
        return None;
    }
    let status = Command::new("service")
        .args([name, "status"])
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .status()
        .ok()?;
    Some(status.success())
}

fn try_openrc(name: &str) -> Option<bool> {
    if !command_exists("rc-service") {
        return None;
    }
    let status = Command::new("rc-service")
        .args([name, "status"])
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .status()
        .ok()?;
    Some(status.success())
}

fn command_exists(cmd: &str) -> bool {
    Command::new("which")
        .arg(cmd)
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn check_process_path(app_id: &str, path_prefixes: &[&str]) -> bool {
    use std::fs;

    let proc_dir = match fs::read_dir("/proc") {
        Ok(d) => d,
        Err(_) => {
            trace!("EdrChecker: failed to open /proc");
            return false;
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
                if path_prefixes.iter().any(|pfx| exe_str.starts_with(pfx)) {
                    trace!("EdrChecker: found {} (pid {}, exe {})", app_id, name_str, exe_str);
                    return true;
                }
            }
        }
    }

    false
}

fn check_dir_exists(app_id: &str, path: &str) -> bool {
    if Path::new(path).is_dir() {
        trace!("EdrChecker: found {} via directory {}", app_id, path);
        return true;
    }
    false
}
