/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use log::trace;
use std::io::Cursor;
use std::time::Instant;

use crate::disk_encryption::{summarize, DiskEncryption, VolumeState};
use crate::process::{budget_until, run_command_within};

const FDESETUP: &str = "/usr/bin/fdesetup";
const DISKUTIL: &str = "/usr/sbin/diskutil";

// Ignore auxiliary boot-container volumes, which may be intentionally unencrypted.
const SYSTEM_VOLUMES_PREFIX: &str = "/System/Volumes/";

// Mounted physical volumes use /dev/disk*, regardless of mount point.
const DISK_DEVICE_PREFIX: &str = "/dev/disk";

pub fn detect(deadline: Instant) -> DiskEncryption {
    let boot = boot_volume_state(deadline);
    // Secondary volumes affect only an encrypted boot volume.
    let others = if boot == VolumeState::Encrypted {
        other_fixed_volume_states(deadline)
    } else {
        Some(Vec::new())
    };
    summarize(boot, others.as_deref(), "filevault")
}

fn boot_volume_state(deadline: Instant) -> VolumeState {
    let Some(output) =
        budget_until(deadline).and_then(|budget| run_command_within(FDESETUP, &["status"], budget))
    else {
        trace!("DiskEncryption: fdesetup did not complete");
        return VolumeState::Unknown;
    };
    if !output.status.success() {
        trace!("DiskEncryption: fdesetup failed");
        return VolumeState::Unknown;
    }
    parse_fdesetup_status(&String::from_utf8_lossy(&output.stdout))
}

/// Parses `fdesetup status`. Conversion takes precedence over on/off, and
/// deferred enablement remains unencrypted until restart.
pub(crate) fn parse_fdesetup_status(output: &str) -> VolumeState {
    let lowered = output.to_ascii_lowercase();
    if lowered.contains("encryption in progress") || lowered.contains("decryption in progress") {
        return VolumeState::Converting;
    }
    if lowered.contains("filevault is on") {
        return VolumeState::Encrypted;
    }
    if lowered.contains("filevault is off") {
        return VolumeState::Unencrypted;
    }
    trace!("DiskEncryption: unrecognized fdesetup output");
    VolumeState::Unknown
}

/// Returns `None` if the mount table is unavailable. Volumes left when the
/// deadline expires count as unknown, so evidence gathered before then is kept.
fn other_fixed_volume_states(deadline: Instant) -> Option<Vec<VolumeState>> {
    let devices = mounted_filesystems()?
        .into_iter()
        .filter(|(device, mount_point)| is_other_volume_mount(device, mount_point))
        .map(|(device, _)| device);

    let mut states = Vec::new();
    for device in devices {
        let Some(budget) = budget_until(deadline) else {
            trace!("DiskEncryption: ran out of time inspecting volumes");
            states.push(VolumeState::Unknown);
            break;
        };
        if let Some(state) = volume_state(&device, budget) {
            states.push(state);
        }
    }
    Some(states)
}

/// Selects mounted disk volumes other than boot-container members.
fn is_other_volume_mount(device: &str, mount_point: &str) -> bool {
    device.starts_with(DISK_DEVICE_PREFIX)
        && mount_point != "/"
        && !mount_point.starts_with(SYSTEM_VOLUMES_PREFIX)
}

/// Reads mounted filesystems with `getfsstat(MNT_NOWAIT)`, avoiding
/// `getmntinfo`'s process-wide buffer and filesystem-stat refreshes.
fn mounted_filesystems() -> Option<Vec<(String, String)>> {
    let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if count < 0 {
        trace!("DiskEncryption: getfsstat failed");
        return None;
    }

    let mut buf: Vec<libc::statfs> = vec![unsafe { std::mem::zeroed() }; count as usize];
    let size = std::mem::size_of_val(buf.as_slice()) as libc::c_int;
    let written = unsafe { libc::getfsstat(buf.as_mut_ptr(), size, libc::MNT_NOWAIT) };
    if written < 0 {
        trace!("DiskEncryption: getfsstat failed");
        return None;
    }

    // Ignore filesystems mounted after sizing the snapshot.
    buf.truncate((written as usize).min(count as usize));
    Some(
        buf.iter()
            .map(|fs| {
                (
                    c_array_to_string(&fs.f_mntfromname),
                    c_array_to_string(&fs.f_mntonname),
                )
            })
            .collect(),
    )
}

fn c_array_to_string(field: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = field
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Returns `None` for non-internal or removable media.
fn volume_state(device: &str, budget: std::time::Duration) -> Option<VolumeState> {
    let Some(output) = run_command_within(DISKUTIL, &["info", "-plist", device], budget) else {
        trace!("DiskEncryption: diskutil did not complete for {}", device);
        return Some(VolumeState::Unknown);
    };
    if !output.status.success() {
        trace!("DiskEncryption: diskutil failed for {}", device);
        return Some(VolumeState::Unknown);
    }
    parse_diskutil_info(&output.stdout)
}

pub(crate) fn parse_diskutil_info(plist: &[u8]) -> Option<VolumeState> {
    let Ok(value) = plist::Value::from_reader_xml(Cursor::new(plist)) else {
        trace!("DiskEncryption: could not parse diskutil output");
        return Some(VolumeState::Unknown);
    };
    let Some(info) = value.as_dictionary() else {
        return Some(VolumeState::Unknown);
    };
    let flag = |key: &str| info.get(key).and_then(plist::Value::as_boolean);

    let internal = flag("Internal");
    let removable = flag("RemovableMedia");
    if internal == Some(false) || removable == Some(true) {
        return None;
    }
    // Treat missing classification as unknown.
    if internal.is_none() || removable.is_none() {
        return Some(VolumeState::Unknown);
    }
    Some(match flag("Encryption") {
        Some(true) => VolumeState::Encrypted,
        Some(false) => VolumeState::Unencrypted,
        None => VolumeState::Unknown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fdesetup_states() {
        assert_eq!(
            parse_fdesetup_status("FileVault is On.\n"),
            VolumeState::Encrypted
        );
        assert_eq!(
            parse_fdesetup_status("FileVault is Off.\n"),
            VolumeState::Unencrypted
        );
        assert_eq!(
            parse_fdesetup_status(
                "FileVault is Off, but will be enabled after the next restart.\n"
            ),
            VolumeState::Unencrypted
        );
        assert_eq!(
            parse_fdesetup_status(
                "FileVault is On.\nEncryption in progress: Percent completed = 12\n"
            ),
            VolumeState::Converting
        );
        assert_eq!(
            parse_fdesetup_status("Decryption in progress: Percent completed = 42\n"),
            VolumeState::Converting
        );
        assert_eq!(parse_fdesetup_status(""), VolumeState::Unknown);
        assert_eq!(
            parse_fdesetup_status("Error: unable to determine status."),
            VolumeState::Unknown
        );
    }

    #[test]
    fn volumes_are_taken_from_any_mount_point_on_a_disk() {
        // Include fstab mounts outside /Volumes.
        assert!(is_other_volume_mount("/dev/disk4s1", "/srv/data"));
        assert!(is_other_volume_mount("/dev/disk4s1", "/Volumes/Data"));

        // Exclude the boot volume and its auxiliary container volumes.
        assert!(!is_other_volume_mount("/dev/disk3s1s1", "/"));
        assert!(!is_other_volume_mount(
            "/dev/disk3s5",
            "/System/Volumes/Data"
        ));
        assert!(!is_other_volume_mount(
            "/dev/disk3s2",
            "/System/Volumes/Preboot"
        ));

        // Exclude synthetic roots, network shares and virtual filesystems.
        assert!(!is_other_volume_mount("map -hosts", "/net"));
        assert!(!is_other_volume_mount("//user@nas/share", "/Volumes/share"));
        assert!(!is_other_volume_mount("devfs", "/dev"));
    }

    /// Representative `diskutil info -plist` output for an encrypted internal
    /// APFS volume.
    const REAL_DISKUTIL_INFO: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AESHardware</key>
	<true/>
	<key>APFSPhysicalStores</key>
	<array>
		<dict>
			<key>APFSPhysicalStore</key>
			<string>disk0s2</string>
		</dict>
	</array>
	<key>DeviceNode</key>
	<string>/dev/disk3s1s1</string>
	<key>Encryption</key>
	<true/>
	<key>EncryptionThisVolumeProper</key>
	<false/>
	<key>Internal</key>
	<true/>
	<key>RemovableMedia</key>
	<false/>
	<key>VolumeName</key>
	<string>Macintosh HD</string>
</dict>
</plist>
"#;

    fn diskutil_info(internal: &str, removable: &str, encryption: &str) -> String {
        format!(
            "<plist version=\"1.0\"><dict>\
             <key>Encryption</key>{}\
             <key>Internal</key>{}\
             <key>RemovableMedia</key>{}\
             </dict></plist>",
            encryption, internal, removable
        )
    }

    #[test]
    fn real_diskutil_output_is_understood() {
        assert_eq!(
            parse_diskutil_info(REAL_DISKUTIL_INFO.as_bytes()),
            Some(VolumeState::Encrypted)
        );
    }

    #[test]
    fn diskutil_info_reports_fixed_internal_volumes() {
        assert_eq!(
            parse_diskutil_info(diskutil_info("<true/>", "<false/>", "<true/>").as_bytes()),
            Some(VolumeState::Encrypted)
        );
        assert_eq!(
            parse_diskutil_info(diskutil_info("<true/>", "<false/>", "<false/>").as_bytes()),
            Some(VolumeState::Unencrypted)
        );
        assert_eq!(
            parse_diskutil_info(
                diskutil_info("<true/>", "<false/>", "<string>?</string>").as_bytes()
            ),
            Some(VolumeState::Unknown)
        );
    }

    #[test]
    fn diskutil_info_filters_external_and_removable_volumes() {
        assert_eq!(
            parse_diskutil_info(diskutil_info("<false/>", "<false/>", "<false/>").as_bytes()),
            None
        );
        assert_eq!(
            parse_diskutil_info(diskutil_info("<true/>", "<true/>", "<false/>").as_bytes()),
            None
        );
    }

    #[test]
    fn unparseable_diskutil_output_is_unknown() {
        assert_eq!(parse_diskutil_info(b""), Some(VolumeState::Unknown));
        assert_eq!(
            parse_diskutil_info(b"<plist version=\"1.0\"><dict><key>Truncat"),
            Some(VolumeState::Unknown)
        );
        assert_eq!(
            parse_diskutil_info(b"<plist version=\"1.0\"><array/></plist>"),
            Some(VolumeState::Unknown)
        );
    }
}
