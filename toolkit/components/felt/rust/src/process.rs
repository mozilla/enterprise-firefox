/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub(crate) fn run_command_bounded(program: &str, args: &[&str]) -> Option<Output> {
    run_command_within(program, args, PROBE_TIMEOUT)
}

/// Returns the remaining sweep budget capped at `PROBE_TIMEOUT`, or `None` if
/// expired.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn budget_until(deadline: Instant) -> Option<Duration> {
    let left = deadline.saturating_duration_since(Instant::now());
    (!left.is_zero()).then(|| left.min(PROBE_TIMEOUT))
}

/// Runs a command for at most `budget`, killing and reaping it on timeout.
///
/// Output is read after the child exits; a child blocked on a full pipe times out.
pub(crate) fn run_command_within(program: &str, args: &[&str], budget: Duration) -> Option<Output> {
    use std::io::Read;

    let mut command = Command::new(program);
    scrub_environment(&mut command);
    let mut child = command
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_end(&mut stdout);
                }
                return Some(Output {
                    status,
                    stdout,
                    stderr: Vec::new(),
                });
            }
            Ok(None) => {
                if start.elapsed() >= budget {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                thread::sleep(PROBE_POLL_INTERVAL);
            }
            Err(_) => {
                // Dropping a Child neither kills nor reaps it.
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Probe output is trusted, so the child must not inherit variables such as
/// LD_PRELOAD or DYLD_INSERT_LIBRARIES that let the user alter it. Windows
/// system tools need their inherited environment and have no equivalent.
#[cfg(unix)]
fn scrub_environment(command: &mut Command) {
    command
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LC_ALL", "C");
}

#[cfg(not(unix))]
fn scrub_environment(_command: &mut Command) {}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn children_do_not_inherit_the_environment() {
        std::env::set_var("FELT_PROBE_LEAK", "inherited");
        let output = run_command_bounded(
            "/bin/sh",
            &["-c", "echo \"${FELT_PROBE_LEAK-unset}|$LC_ALL\""],
        )
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "unset|C\n");
    }

    #[test]
    fn relative_programs_resolve_through_the_fixed_path() {
        let output = run_command_bounded("sh", &["-c", "echo ok"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "ok\n");
    }

    #[test]
    fn captures_output() {
        let output = run_command_bounded("/bin/echo", &["hello"]).unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "hello\n");
    }

    #[test]
    fn preserves_nonzero_exit_status_and_output() {
        let output = run_command_bounded("/bin/sh", &["-c", "echo partial; exit 3"]).unwrap();
        assert!(!output.status.success());
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&output.stdout), "partial\n");
    }

    #[test]
    fn returns_none_when_spawn_fails() {
        assert!(run_command_bounded("/nonexistent/felt-probe", &[]).is_none());
    }

    #[test]
    fn returns_none_on_timeout() {
        let budget = Duration::from_millis(200);
        let start = Instant::now();
        assert!(run_command_within("/bin/sleep", &["300"], budget).is_none());
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
