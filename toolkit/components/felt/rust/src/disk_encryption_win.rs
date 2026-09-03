/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use log::trace;
use std::time::Instant;

use winapi::shared::minwindef::MAX_PATH;
use winapi::shared::winerror::{ERROR_MORE_DATA, ERROR_NO_MORE_FILES};
use winapi::um::errhandlingapi::GetLastError;
use winapi::um::fileapi::{
    FindFirstVolumeW, FindNextVolumeW, FindVolumeClose, GetDriveTypeW,
    GetVolumeNameForVolumeMountPointW, GetVolumePathNamesForVolumeNameW,
};
use winapi::um::handleapi::INVALID_HANDLE_VALUE;
use winapi::um::sysinfoapi::GetWindowsDirectoryW;
use winapi::um::winbase::DRIVE_FIXED;

use crate::disk_encryption::{summarize, DiskEncryption, VolumeState};

extern "C" {
    // Reads Explorer's unprivileged BitLocker property; see FeltDiskEncryptionWin.cpp.
    fn felt_read_bitlocker_protection(root: *const u16, out_value: *mut i32) -> bool;
}

// A volume GUID path, "\\?\Volume{...}\", is 49 characters plus a terminator,
// so the MAX_PATH + 1 buffer the documentation suggests is not needed.
const VOLUME_NAME_LEN: usize = 64;

/// A fixed volume identified by GUID, with one path used to query it.
struct Volume {
    guid_path: String,
    mount_path: String,
}

/// The mounted fixed volumes. `complete` is false when a volume could not be
/// examined and may be missing from `list`.
struct Volumes {
    list: Vec<Volume>,
    complete: bool,
}

/// Shell property reads are synchronous, so the deadline is checked between calls.
pub fn detect(deadline: Instant) -> DiskEncryption {
    if Instant::now() >= deadline {
        return DiskEncryption::unknown();
    }
    let Some(volumes) = fixed_volumes() else {
        trace!("DiskEncryption: could not enumerate volumes");
        return DiskEncryption::unknown();
    };
    let Some(boot_guid) = boot_volume_guid_path() else {
        trace!("DiskEncryption: could not determine the boot volume");
        return DiskEncryption::unknown();
    };

    let Some(boot_volume) = volumes
        .list
        .iter()
        .find(|volume| volume.guid_path.eq_ignore_ascii_case(&boot_guid))
    else {
        trace!("DiskEncryption: the boot volume is not among the fixed volumes");
        return DiskEncryption::unknown();
    };

    if Instant::now() >= deadline {
        trace!("DiskEncryption: deadline expired before checking the boot volume");
        return DiskEncryption::unknown();
    }
    let boot = volume_state(&boot_volume.mount_path);
    // Secondary volumes affect only an encrypted boot volume.
    let others = if boot == VolumeState::Encrypted {
        let mut states = other_volume_states(&volumes.list, &boot_guid, deadline);
        if !volumes.complete {
            // A volume that could not be examined counts as unknown.
            states.push(VolumeState::Unknown);
        }
        states
    } else {
        Vec::new()
    };

    summarize(boot, Some(&others), "bitlocker")
}

/// Volumes left when the deadline expires count as unknown, so evidence
/// gathered before then is kept.
fn other_volume_states(volumes: &[Volume], boot_guid: &str, deadline: Instant) -> Vec<VolumeState> {
    let mut states = Vec::new();
    for volume in volumes {
        if volume.guid_path.eq_ignore_ascii_case(boot_guid) {
            continue;
        }
        if Instant::now() >= deadline {
            trace!("DiskEncryption: deadline expired while checking volumes");
            states.push(VolumeState::Unknown);
            break;
        }
        states.push(volume_state(&volume.mount_path));
    }
    states
}

/// Enumerates mounted fixed volumes, or returns `None` if enumeration cannot
/// start at all.
fn fixed_volumes() -> Option<Volumes> {
    let mut name = [0u16; VOLUME_NAME_LEN];
    let handle = unsafe { FindFirstVolumeW(name.as_mut_ptr(), name.len() as u32) };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }

    let mut list = Vec::new();
    let mut complete = true;
    loop {
        let guid_path = from_wide(&name);
        match first_mount_path(&guid_path) {
            Ok(Some(mount_path)) => {
                if is_fixed_drive(&guid_path) {
                    list.push(Volume {
                        guid_path,
                        mount_path,
                    });
                }
            }
            // Unmounted fixed volumes are the EFI system and recovery
            // partitions, which hold no user data and are never encrypted.
            Ok(None) => {}
            Err(()) => complete = false,
        }

        if unsafe { FindNextVolumeW(handle, name.as_mut_ptr(), name.len() as u32) } == 0 {
            // Only ERROR_NO_MORE_FILES means enumeration completed.
            complete &= unsafe { GetLastError() } == ERROR_NO_MORE_FILES;
            break;
        }
    }
    unsafe { FindVolumeClose(handle) };

    Some(Volumes { list, complete })
}

/// Returns the first mount point, or `Ok(None)` if the volume is unmounted.
fn first_mount_path(guid_path: &str) -> Result<Option<String>, ()> {
    let name = to_wide(guid_path);
    // The API requires room for the complete MULTI_SZ even though only one path is used.
    let mut buf = vec![0u16; MAX_PATH + 1];
    loop {
        let mut len = 0u32;
        let ok = unsafe {
            GetVolumePathNamesForVolumeNameW(
                name.as_ptr(),
                buf.as_mut_ptr(),
                buf.len() as u32,
                &mut len,
            )
        };
        if ok != 0 {
            let first = from_wide(&buf);
            return Ok((!first.is_empty()).then_some(first));
        }
        if unsafe { GetLastError() } != ERROR_MORE_DATA || len as usize <= buf.len() {
            trace!("DiskEncryption: mount-point query failed for {}", guid_path);
            return Err(());
        }
        buf.resize(len as usize, 0);
    }
}

fn boot_volume_guid_path() -> Option<String> {
    let mut buf = [0u16; MAX_PATH + 1];
    let len = unsafe { GetWindowsDirectoryW(buf.as_mut_ptr(), buf.len() as u32) };
    if len == 0 || len as usize > buf.len() {
        return None;
    }
    let root = drive_root(&String::from_utf16_lossy(&buf[..len as usize]))?;

    let mut name = [0u16; VOLUME_NAME_LEN];
    let ok = unsafe {
        GetVolumeNameForVolumeMountPointW(
            to_wide(&root).as_ptr(),
            name.as_mut_ptr(),
            name.len() as u32,
        )
    };
    (ok != 0).then(|| from_wide(&name))
}

/// Returns the root of a drive-letter path.
fn drive_root(path: &str) -> Option<String> {
    let mut chars = path.chars();
    let letter = chars.next()?;
    if !letter.is_ascii_alphabetic() || chars.next()? != ':' {
        return None;
    }
    Some(format!("{}:\\", letter))
}

fn is_fixed_drive(volume_path: &str) -> bool {
    unsafe { GetDriveTypeW(to_wide(volume_path).as_ptr()) == DRIVE_FIXED }
}

fn volume_state(mount_path: &str) -> VolumeState {
    let path = to_wide(mount_path);
    let mut value: i32 = 0;
    if unsafe { felt_read_bitlocker_protection(path.as_ptr(), &mut value) } {
        map_bitlocker_value(value)
    } else {
        trace!("DiskEncryption: no BitLocker property for {}", mount_path);
        VolumeState::Unknown
    }
}

/// Maps System.Volume.BitLockerProtection values to volume states.
/// Locked volumes remain encrypted; suspended and pre-provisioned volumes have
/// a clear key and count as unencrypted.
pub(crate) fn map_bitlocker_value(value: i32) -> VolumeState {
    match value {
        1 | 6 => VolumeState::Encrypted,
        2 | 5 | 7 | 8 => VolumeState::Unencrypted,
        3 | 4 => VolumeState::Converting,
        _ => VolumeState::Unknown,
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitlocker_values_map_to_volume_states() {
        for (value, state) in [
            (1, VolumeState::Encrypted),   // on
            (2, VolumeState::Unencrypted), // off
            (3, VolumeState::Converting),  // encrypting
            (4, VolumeState::Converting),  // decrypting
            (5, VolumeState::Unencrypted), // suspended: clear key on the disk
            (6, VolumeState::Encrypted),   // on, not unlocked this session
            (7, VolumeState::Unencrypted), // off and cannot be turned on
            (8, VolumeState::Unencrypted), // waiting for activation: clear key
        ] {
            assert_eq!(map_bitlocker_value(value), state, "value {}", value);
        }

        for undefined in [-1, 0, 9, 42] {
            assert_eq!(map_bitlocker_value(undefined), VolumeState::Unknown);
        }
    }

    #[test]
    fn drive_roots_are_reduced_from_paths() {
        assert_eq!(drive_root("C:\\Windows"), Some("C:\\".to_string()));
        assert_eq!(drive_root("D:\\"), Some("D:\\".to_string()));
        assert_eq!(drive_root("\\\\server\\share"), None);
        assert_eq!(drive_root(""), None);
    }

    #[test]
    fn wide_strings_stop_at_the_terminator() {
        let mut buf = [0u16; 8];
        for (slot, c) in buf.iter_mut().zip("D:\\\0junk".encode_utf16()) {
            *slot = c;
        }
        assert_eq!(from_wide(&buf), "D:\\");
        assert_eq!(from_wide(&[0u16; 4]), "");
    }
}
