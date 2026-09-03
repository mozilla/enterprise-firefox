/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use log::trace;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::Path;
use std::time::Instant;

use crate::disk_encryption::{summarize, DiskEncryption, VolumeState};
use crate::process::{budget_until, run_command_within};

const MOUNTINFO: &str = "/proc/self/mountinfo";
const SWAPS: &str = "/proc/swaps";
const SYS_DEV_BLOCK: &str = "/sys/dev/block";
const SYS_FS_BTRFS: &str = "/sys/fs/btrfs";

// Limit recursion through malformed device graphs.
const MAX_STACK_DEPTH: u32 = 8;

// LUKS and plain dm-crypt mapper UUIDs start with CRYPT-.
const DM_CRYPT_UUID_PREFIX: &str = "CRYPT-";

// cryptsetup types sharing that prefix which store plaintext.
const DM_INTEGRITY_ONLY_UUID_PREFIXES: &[&str] = &["CRYPT-VERITY-", "CRYPT-INTEGRITY-"];

// The mapping table is the only proof of the cipher, and the kernel discloses
// it to root alone. Without it, a LUKS mapping is trusted because a LUKS header
// only carries a null cipher when deliberately created for debugging, whereas a
// plain dm-crypt mapping takes its cipher from the command line. The UUID is
// creator-supplied, so the table is checked whenever it is readable.
const DM_LUKS_UUID_PREFIX: &str = "CRYPT-LUKS";

// Ignore virtual filesystems and loop devices whose backing files are checked
// through their mounted volumes. Pooled filesystems report an anonymous device
// number too, but name their storage in the mount source.
const VIRTUAL_MAJOR: &str = "0";
const LOOP_MAJOR: &str = "7";

const BTRFS_FSTYPE: &str = "btrfs";
const ZFS_FSTYPE: &str = "zfs";

// zram is memory-backed and has no data-at-rest exposure.
const VOLATILE_DEVICE_PREFIX: &str = "zram";

// Boot partitions contain no user data and are commonly unencrypted. Only these
// exact mount points are skipped, so a data volume below them still counts.
const UNENCRYPTABLE_MOUNTS: &[&str] = &["/boot", "/boot/efi", "/efi"];

// The zfs tools live in sbin, which is not always on PATH.
const ZFS_TOOL: &[&str] = &["/usr/sbin/zfs", "/sbin/zfs"];
const ZPOOL_TOOL: &[&str] = &["/usr/sbin/zpool", "/sbin/zpool"];
const DMSETUP_TOOL: &[&str] = &["/usr/sbin/dmsetup", "/sbin/dmsetup"];

// Values of the ZFS `encryption` property that mean no native encryption.
const ZFS_PLAINTEXT: &[&str] = &["", "-", "off"];

const DM_CRYPT_METHOD: &str = "dm-crypt";
const ZFS_METHOD: &str = "zfs";

/// The sysfs directories consulted while resolving storage.
pub(crate) struct Sysfs<'a> {
    pub dev_block: &'a Path,
    pub fs_btrfs: &'a Path,
}

pub fn detect(deadline: Instant) -> DiskEncryption {
    let Ok(mountinfo) = fs::read_to_string(MOUNTINFO) else {
        trace!("DiskEncryption: could not read {}", MOUNTINFO);
        return DiskEncryption::unknown();
    };
    let swaps = match fs::read_to_string(SWAPS) {
        Ok(swaps) => swap_areas(&swaps),
        Err(_) => {
            trace!("DiskEncryption: could not read {}", SWAPS);
            vec![SwapArea::Unresolved]
        }
    };
    let zfs = if parse_mountinfo(&mountinfo)
        .iter()
        .any(|mount| mount.fstype == ZFS_FSTYPE)
    {
        probe_zfs(deadline)
    } else {
        ZfsTables::default()
    };

    let inspect_dm_crypt = |dir: &Path| dm_crypt_is_confidential(dir, deadline);
    detect_at(
        &Sysfs {
            dev_block: Path::new(SYS_DEV_BLOCK),
            fs_btrfs: Path::new(SYS_FS_BTRFS),
        },
        &mountinfo,
        &swaps,
        &zfs,
        deadline,
        &inspect_dm_crypt,
    )
}

/// Runs detection with supplied procfs, sysfs and ZFS data.
pub(crate) fn detect_at(
    sysfs: &Sysfs,
    mountinfo: &str,
    swap_areas: &[SwapArea],
    zfs: &ZfsTables,
    deadline: Instant,
    inspect_dm_crypt: &dyn Fn(&Path) -> Option<bool>,
) -> DiskEncryption {
    let mounts = parse_mountinfo(mountinfo);

    let Some(root) = root_mount(&mounts) else {
        trace!("DiskEncryption: no root mount in mountinfo");
        return DiskEncryption::unknown();
    };
    let Some(root_backing) = backing_of(sysfs, root) else {
        trace!("DiskEncryption: no storage found behind {}", root.source);
        return DiskEncryption::unknown();
    };

    let boot = volume_state(sysfs, zfs, &root_backing, inspect_dm_crypt);
    let others = if matches!(
        boot,
        VolumeState::Encrypted | VolumeState::EncryptedUnverified
    ) {
        other_fixed_volume_states(
            sysfs,
            zfs,
            &mounts,
            swap_areas,
            &root_backing,
            deadline,
            inspect_dm_crypt,
        )
    } else {
        Vec::new()
    };

    summarize(boot, Some(&others), method_of(zfs, &root_backing))
}

pub(crate) struct MountEntry {
    /// "major:minor" of the device backing the mount, anonymous for pooled
    /// filesystems.
    pub devno: String,
    pub mount_point: String,
    pub fstype: String,
    /// A device path, or a dataset name for ZFS.
    pub source: String,
}

/// Parses `/proc/self/mountinfo`, whose variable-length optional fields are
/// terminated by a lone "-" before the filesystem type and mount source.
pub(crate) fn parse_mountinfo(text: &str) -> Vec<MountEntry> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let devno = fields.nth(2)?;
            let mount_point = fields.nth(1)?;
            let mut tail = fields.skip_while(|field| *field != "-").skip(1);
            let fstype = tail.next()?;
            let source = tail.next()?;
            Some(MountEntry {
                devno: devno.to_string(),
                mount_point: unescape_mount_path(mount_point),
                fstype: fstype.to_string(),
                source: unescape_mount_path(source),
            })
        })
        .collect()
}

/// Decodes procfs octal escapes, which encode individual UTF-8 bytes.
fn unescape_mount_path(path: &str) -> String {
    let mut out = Vec::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let escaped = bytes.get(i + 1..i + 4).filter(|_| bytes[i] == b'\\');
        match escaped.and_then(|digits| std::str::from_utf8(digits).ok()) {
            Some(digits) if digits.bytes().all(|d| (b'0'..=b'7').contains(&d)) => {
                out.push(u8::from_str_radix(digits, 8).unwrap_or(b'?'));
                i += 4;
            }
            _ => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The mount backing "/". A later mount over "/" shadows an earlier one, so the
/// last entry wins.
pub(crate) fn root_mount(mounts: &[MountEntry]) -> Option<&MountEntry> {
    mounts.iter().rev().find(|m| m.mount_point == "/")
}

/// Inspects each mounted fixed volume and swap area once. A volume whose
/// storage cannot be resolved counts as unknown, as do the volumes left when
/// the deadline expires, so evidence gathered before then is kept.
fn other_fixed_volume_states(
    sysfs: &Sysfs,
    zfs: &ZfsTables,
    mounts: &[MountEntry],
    swap_areas: &[SwapArea],
    root: &Backing,
    deadline: Instant,
    inspect_dm_crypt: &dyn Fn(&Path) -> Option<bool>,
) -> Vec<VolumeState> {
    let mounted = mounts
        .iter()
        .filter(|mount| is_fixed_volume_mount(mount))
        .map(|mount| backing_of(sysfs, mount));
    let swapped = swap_areas.iter().map(|area| match area {
        SwapArea::Device(devno) => swap_backing(sysfs, mounts, devno),
        SwapArea::Unresolved => None,
    });

    let mut seen = HashSet::from([backing_key(root)]);
    let mut states = Vec::new();

    for backing in mounted.chain(swapped) {
        let Some(backing) = backing else {
            states.push(VolumeState::Unknown);
            continue;
        };
        if !seen.insert(backing_key(&backing)) || is_ignorable(sysfs, &backing) {
            continue;
        }
        if Instant::now() >= deadline {
            trace!("DiskEncryption: ran out of time walking the block devices");
            states.push(VolumeState::Unknown);
            break;
        }
        states.push(volume_state(sysfs, zfs, &backing, inspect_dm_crypt));
    }

    states
}

/// Swap on a pooled filesystem reports that filesystem's anonymous device
/// number, so the mount it belongs to resolves it.
fn swap_backing(sysfs: &Sysfs, mounts: &[MountEntry], devno: &str) -> Option<Backing> {
    match mounts.iter().find(|mount| mount.devno == devno) {
        Some(mount) => backing_of(sysfs, mount),
        None => Some(Backing::Devices(vec![devno.to_string()])),
    }
}

/// An active swap area from `/proc/swaps`.
pub(crate) enum SwapArea {
    /// The "major:minor" of the device holding the swap area.
    Device(String),
    /// The area exists but its storage could not be determined.
    Unresolved,
}

fn swap_areas(swaps: &str) -> Vec<SwapArea> {
    parse_swaps(swaps)
        .iter()
        .map(|path| match devno_of(Path::new(path)) {
            Some(devno) => SwapArea::Device(devno),
            None => {
                trace!("DiskEncryption: could not resolve swap area {}", path);
                SwapArea::Unresolved
            }
        })
        .collect()
}

/// The first column of `/proc/swaps`, which names either a block device or a
/// file, after its one-line header.
pub(crate) fn parse_swaps(swaps: &str) -> Vec<String> {
    swaps
        .lines()
        .skip(1)
        .filter_map(|line| line.split_whitespace().next())
        .map(unescape_mount_path)
        .collect()
}

/// The "major:minor" of a swap area: the device itself for a partition, and the
/// filesystem it lives on for a swap file.
fn devno_of(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    let dev = if metadata.file_type().is_block_device() {
        metadata.rdev()
    } else {
        metadata.dev()
    };
    Some(format!("{}:{}", dev_major(dev), dev_minor(dev)))
}

// Mirror glibc's split-bit gnu_dev_major/gnu_dev_minor encoding.
fn dev_major(dev: u64) -> u32 {
    (((dev >> 8) & 0xfff) as u32) | (((dev >> 32) as u32) & !0xfff)
}

fn dev_minor(dev: u64) -> u32 {
    ((dev & 0xff) as u32) | (((dev >> 12) as u32) & !0xff)
}

fn is_fixed_volume_mount(mount: &MountEntry) -> bool {
    let major = major_of(&mount.devno);
    if major == LOOP_MAJOR {
        return false;
    }
    if major == VIRTUAL_MAJOR && !is_pooled(&mount.fstype) {
        return false;
    }
    !UNENCRYPTABLE_MOUNTS.contains(&mount.mount_point.as_str())
}

fn major_of(devno: &str) -> &str {
    devno.split(':').next().unwrap_or_default()
}

/// Whether the filesystem spans devices it names in the mount source rather
/// than reporting one in mountinfo.
fn is_pooled(fstype: &str) -> bool {
    fstype == BTRFS_FSTYPE || fstype == ZFS_FSTYPE
}

/// The storage a mount is judged by.
enum Backing {
    /// Block devices, each walked through sysfs.
    Devices(Vec<String>),
    /// A ZFS dataset, judged with the zfs tools.
    Zfs(String),
}

/// Resolves a mount to its storage, or `None` when it has none to inspect.
fn backing_of(sysfs: &Sysfs, mount: &MountEntry) -> Option<Backing> {
    if major_of(&mount.devno) != VIRTUAL_MAJOR {
        return Some(Backing::Devices(vec![mount.devno.clone()]));
    }
    match mount.fstype.as_str() {
        BTRFS_FSTYPE => btrfs_devnos(sysfs, &mount.source).map(Backing::Devices),
        ZFS_FSTYPE => Some(Backing::Zfs(mount.source.clone())),
        _ => None,
    }
}

/// Identifies storage so that several mounts of it are inspected once.
fn backing_key(backing: &Backing) -> String {
    match backing {
        Backing::Devices(devnos) => {
            let mut sorted = devnos.clone();
            sorted.sort();
            sorted.join(",")
        }
        Backing::Zfs(dataset) => format!("{}:{}", ZFS_FSTYPE, dataset),
    }
}

/// Volumes with no data at rest to protect.
fn is_ignorable(sysfs: &Sysfs, backing: &Backing) -> bool {
    match backing {
        Backing::Devices(devnos) => devnos
            .iter()
            .any(|devno| is_volatile(sysfs, devno) || is_removable(sysfs, devno)),
        Backing::Zfs(_) => false,
    }
}

fn volume_state(
    sysfs: &Sysfs,
    zfs: &ZfsTables,
    backing: &Backing,
    inspect_dm_crypt: &dyn Fn(&Path) -> Option<bool>,
) -> VolumeState {
    match backing {
        Backing::Devices(devnos) => combine(
            devnos
                .iter()
                .map(|devno| device_state(sysfs, devno, inspect_dm_crypt)),
        ),
        Backing::Zfs(dataset) => zfs_state(sysfs, zfs, dataset, inspect_dm_crypt),
    }
}

/// Names the mechanism the boot volume was judged by.
fn method_of(zfs: &ZfsTables, backing: &Backing) -> &'static str {
    match backing {
        Backing::Zfs(dataset) if zfs_is_natively_encrypted(zfs, dataset) => ZFS_METHOD,
        _ => DM_CRYPT_METHOD,
    }
}

/// Plaintext in any member makes the whole set plaintext; otherwise a member
/// that cannot be inspected makes it unknown.
fn combine(states: impl Iterator<Item = VolumeState>) -> VolumeState {
    let states: Vec<VolumeState> = states.collect();
    if states.contains(&VolumeState::Unencrypted) {
        VolumeState::Unencrypted
    } else if states.is_empty() || states.contains(&VolumeState::Unknown) {
        VolumeState::Unknown
    } else if states.contains(&VolumeState::EncryptedUnverified) {
        VolumeState::EncryptedUnverified
    } else {
        VolumeState::Encrypted
    }
}

/// Every device of the btrfs filesystem mounted from `source`. Only sysfs
/// reports the other devices of a multi-device filesystem, so the mount source
/// alone is used just when sysfs does not list it.
fn btrfs_devnos(sysfs: &Sysfs, source: &str) -> Option<Vec<String>> {
    let name = device_name(source);
    match btrfs_filesystem(sysfs.fs_btrfs, &name) {
        BtrfsFilesystem::Devices(devnos) => Some(devnos),
        BtrfsFilesystem::Unreadable => None,
        BtrfsFilesystem::Unlisted => Some(vec![devno_for_name(sysfs.dev_block, &name)?]),
    }
}

/// What /sys/fs/btrfs says about a mounted device.
enum BtrfsFilesystem {
    /// Every device of the filesystem holding it.
    Devices(Vec<String>),
    /// Its filesystem was found, but the device list was incomplete.
    Unreadable,
    /// No filesystem lists it.
    Unlisted,
}

fn btrfs_filesystem(fs_btrfs: &Path, name: &str) -> BtrfsFilesystem {
    let Ok(filesystems) = fs::read_dir(fs_btrfs) else {
        return BtrfsFilesystem::Unlisted;
    };

    for filesystem in filesystems.flatten() {
        let Ok(devices) = fs::read_dir(filesystem.path().join("devices")) else {
            continue;
        };

        let mut devnos = Vec::new();
        let mut holds_name = false;
        let mut complete = true;
        for device in devices.flatten() {
            holds_name |= device.file_name().to_str() == Some(name);
            match fs::read_to_string(device.path().join("dev")) {
                Ok(devno) => devnos.push(devno.trim().to_string()),
                Err(_) => complete = false,
            }
        }

        if holds_name {
            return if complete {
                BtrfsFilesystem::Devices(devnos)
            } else {
                BtrfsFilesystem::Unreadable
            };
        }
    }

    BtrfsFilesystem::Unlisted
}

/// The kernel name of a device path, resolving links like /dev/mapper/root.
fn device_name(source: &str) -> String {
    let path = Path::new(source);
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Finds the device number of a kernel device name, since `/sys/dev/block`
/// entries are named by number and link to the named directory.
fn devno_for_name(sys_dev_block: &Path, name: &str) -> Option<String> {
    fs::read_dir(sys_dev_block)
        .ok()?
        .flatten()
        .find_map(|entry| {
            let resolved = entry.path().canonicalize().ok()?;
            (resolved.file_name()?.to_str()? == name)
                .then(|| entry.file_name().to_string_lossy().into_owned())
        })
}

/// The ZFS tools report every dataset and pool at once, so one call each is
/// made per sweep.
#[derive(Default)]
pub(crate) struct ZfsTables {
    /// Dataset to the value of its `encryption` property.
    encryption: HashMap<String, String>,
    /// Pool to the device paths of its vdevs.
    vdevs: HashMap<String, Vec<String>>,
}

fn probe_zfs(deadline: Instant) -> ZfsTables {
    ZfsTables {
        encryption: run_zfs_tool(
            ZFS_TOOL,
            &["get", "-H", "-o", "name,value", "encryption"],
            deadline,
        )
        .as_deref()
        .map(parse_zfs_encryption)
        .unwrap_or_default(),
        vdevs: run_zfs_tool(ZPOOL_TOOL, &["status", "-P"], deadline)
            .as_deref()
            .map(parse_zpool_status)
            .unwrap_or_default(),
    }
}

fn run_zfs_tool(candidates: &[&str], args: &[&str], deadline: Instant) -> Option<String> {
    let program = candidates.iter().find(|path| Path::new(path).exists())?;
    let output = run_command_within(program, args, budget_until(deadline)?)?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Parses the tab-separated name and value columns of `zfs get -H`.
pub(crate) fn parse_zfs_encryption(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let (name, value) = line.split_once('\t')?;
            (!name.is_empty()).then(|| (name.to_string(), value.trim().to_string()))
        })
        .collect()
}

/// Collects the leaf vdev paths `zpool status -P` prints beneath each pool.
/// Cache and log devices hold data and are included; hot spares hold none
/// until they replace a device and are skipped.
pub(crate) fn parse_zpool_status(text: &str) -> HashMap<String, Vec<String>> {
    let mut pools: HashMap<String, Vec<String>> = HashMap::new();
    let mut pool = None;
    let mut in_spares = false;

    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(name) = trimmed.strip_prefix("pool:") {
            pool = Some(name.trim().to_string());
            in_spares = false;
            continue;
        }
        let (Some(pool), Some(path)) = (pool.as_ref(), trimmed.split_whitespace().next()) else {
            continue;
        };
        if !path.starts_with('/') {
            in_spares = path == "spares";
        } else if !in_spares {
            pools
                .entry(pool.clone())
                .or_default()
                .push(path.to_string());
        }
    }

    pools
}

fn zfs_is_natively_encrypted(zfs: &ZfsTables, dataset: &str) -> bool {
    zfs.encryption
        .get(dataset)
        .is_some_and(|value| !ZFS_PLAINTEXT.contains(&value.as_str()))
}

/// A dataset is encrypted natively, or by every device under its pool.
fn zfs_state(
    sysfs: &Sysfs,
    zfs: &ZfsTables,
    dataset: &str,
    inspect_dm_crypt: &dyn Fn(&Path) -> Option<bool>,
) -> VolumeState {
    if zfs_is_natively_encrypted(zfs, dataset) {
        return VolumeState::Encrypted;
    }

    let pool = dataset.split('/').next().unwrap_or(dataset);
    let Some(vdevs) = zfs.vdevs.get(pool) else {
        trace!("DiskEncryption: no vdevs reported for pool {}", pool);
        return VolumeState::Unknown;
    };

    combine(vdevs.iter().map(
        |path| match devno_for_name(sysfs.dev_block, &device_name(path)) {
            Some(devno) => device_state(sysfs, &devno, inspect_dm_crypt),
            None => VolumeState::Unknown,
        },
    ))
}

/// Follows sysfs slave links to find dm-crypt below the mounted device.
fn device_state(
    sysfs: &Sysfs,
    devno: &str,
    inspect_dm_crypt: &dyn Fn(&Path) -> Option<bool>,
) -> VolumeState {
    stack_encryption_state(
        &sysfs.dev_block.join(devno),
        MAX_STACK_DEPTH,
        inspect_dm_crypt,
    )
}

fn stack_encryption_state(
    dir: &Path,
    depth: u32,
    inspect_dm_crypt: &dyn Fn(&Path) -> Option<bool>,
) -> VolumeState {
    if depth == 0 {
        trace!("DiskEncryption: device stack too deep at {}", dir.display());
        return VolumeState::Unknown;
    }
    if !dir.exists() {
        trace!("DiskEncryption: no sysfs entry at {}", dir.display());
        return VolumeState::Unknown;
    }
    // A loop device's backing file lives on a filesystem this walk cannot see,
    // as with the squashfs root of a snap-confined browser.
    if dir.join("loop").is_dir() {
        trace!("DiskEncryption: loop device at {}", dir.display());
        return VolumeState::Unknown;
    }

    match fs::read_to_string(dir.join("dm").join("uuid")) {
        Ok(uuid) => {
            let uuid = uuid.trim();
            // Integrity-only devices are examined through their slaves instead.
            if uuid.starts_with(DM_CRYPT_UUID_PREFIX)
                && !DM_INTEGRITY_ONLY_UUID_PREFIXES
                    .iter()
                    .any(|prefix| uuid.starts_with(prefix))
            {
                return match inspect_dm_crypt(dir) {
                    Some(false) => VolumeState::Unencrypted,
                    Some(true) => VolumeState::Encrypted,
                    None if uuid.starts_with(DM_LUKS_UUID_PREFIX) => VolumeState::Encrypted,
                    None => VolumeState::EncryptedUnverified,
                };
            }
        }
        // Non-device-mapper devices have no dm/uuid.
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(_) => return VolumeState::Unknown,
    }

    let slaves = match fs::read_dir(dir.join("slaves")) {
        Ok(slaves) => slaves,
        // Physical storage, the bottom of the stack.
        Err(e) if e.kind() == ErrorKind::NotFound => return VolumeState::Unencrypted,
        Err(_) => return VolumeState::Unknown,
    };

    let mut layers = Vec::new();
    for slave in slaves {
        let Ok(slave) = slave else {
            return VolumeState::Unknown;
        };
        layers.push(stack_encryption_state(
            &slave.path(),
            depth - 1,
            inspect_dm_crypt,
        ));
    }

    if layers.is_empty() {
        VolumeState::Unencrypted
    } else {
        combine(layers.into_iter())
    }
}

/// Reads the mapping table, which the kernel only discloses to root.
fn dm_crypt_is_confidential(dir: &Path, deadline: Instant) -> Option<bool> {
    if unsafe { libc::geteuid() } != 0 {
        return None;
    }
    let name = fs::read_to_string(dir.join("dm").join("name")).ok()?;
    let program = DMSETUP_TOOL.iter().find(|path| Path::new(path).exists())?;
    let output = run_command_within(program, &["table", name.trim()], budget_until(deadline)?)?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout))
        .and_then(|table| parse_dm_crypt_table(&table))
}

/// A CRYPT- device whose table holds a target other than crypt merely carries
/// the UUID and stores plaintext.
pub(crate) fn parse_dm_crypt_table(table: &str) -> Option<bool> {
    let mut found = false;
    for line in table.lines().filter(|line| !line.trim().is_empty()) {
        let mut fields = line.split_whitespace();
        fields.next()?;
        fields.next()?;
        if fields.next()? != "crypt" {
            return Some(false);
        }
        found = true;
        let cipher = fields.next()?.to_ascii_lowercase();
        if cipher
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .any(|part| matches!(part, "null" | "cipher_null"))
        {
            return Some(false);
        }
    }
    found.then_some(true)
}

/// Whether the device exists only in memory, as zram swap does.
fn is_volatile(sysfs: &Sysfs, devno: &str) -> bool {
    let Ok(resolved) = sysfs.dev_block.join(devno).canonicalize() else {
        return false;
    };
    resolved
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(VOLATILE_DEVICE_PREFIX))
}

/// Checks the device and its parent because partitions inherit the whole disk's
/// removable flag.
fn is_removable(sysfs: &Sysfs, devno: &str) -> bool {
    let dir = sysfs.dev_block.join(devno);
    let Ok(resolved) = dir.canonicalize() else {
        return false;
    };

    let mut candidates = vec![resolved.clone()];
    if let Some(parent) = resolved.parent() {
        candidates.push(parent.to_path_buf());
    }

    candidates.iter().any(|candidate| {
        fs::read_to_string(candidate.join("removable")).is_ok_and(|flag| flag.trim() == "1")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::time::Duration;

    fn detect(sysfs: &SysfsFixture, mountinfo: &str) -> DiskEncryption {
        detect_with(sysfs, mountinfo, &[], &ZfsTables::default())
    }

    fn detect_with(
        sysfs: &SysfsFixture,
        mountinfo: &str,
        swap_areas: &[SwapArea],
        zfs: &ZfsTables,
    ) -> DiskEncryption {
        detect_at(
            &sysfs.paths(),
            mountinfo,
            swap_areas,
            zfs,
            Instant::now() + Duration::from_secs(60),
            &|_| Some(true),
        )
    }

    fn swap_on(devno: &str) -> [SwapArea; 1] {
        [SwapArea::Device(devno.to_string())]
    }

    const ROOT_ON_LUKS: &str = "\
23 28 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw
24 28 0:22 / /sys rw,nosuid,nodev,noexec,relatime shared:2 - sysfs sysfs rw
28 1 253:1 / / rw,relatime shared:1 - ext4 /dev/mapper/vg-root rw
31 28 8:2 / /boot rw,relatime shared:15 - ext2 /dev/sda2 rw
32 28 8:1 / /boot/efi rw,relatime shared:16 - vfat /dev/sda1 rw
40 28 7:0 / /snap/core/1234 ro,nodev,relatime shared:20 - squashfs /dev/loop0 ro
45 28 8:16 / /data rw,relatime shared:25 - ext4 /dev/sdb1 rw";

    #[test]
    fn mountinfo_fields_are_read_by_position() {
        let mounts = parse_mountinfo(ROOT_ON_LUKS);
        assert_eq!(mounts.len(), 7);
        assert_eq!(mounts[2].devno, "253:1");
        assert_eq!(mounts[2].mount_point, "/");
        assert_eq!(mounts[2].fstype, "ext4");
        assert_eq!(mounts[2].source, "/dev/mapper/vg-root");
        assert_eq!(mounts[6].devno, "8:16");
        assert_eq!(mounts[6].mount_point, "/data");
    }

    #[test]
    fn the_optional_fields_before_the_separator_are_skipped() {
        let padded = "\
28 1 8:2 / / rw shared:1 master:2 propagate_from:3 unbindable - ext4 /dev/sda2 rw
29 1 8:3 / /srv rw - ext4 /dev/sda3 rw";
        let mounts = parse_mountinfo(padded);
        assert_eq!(mounts[0].fstype, "ext4");
        assert_eq!(mounts[0].source, "/dev/sda2");
        assert_eq!(mounts[1].source, "/dev/sda3");
    }

    #[test]
    fn root_is_the_last_mount_over_slash() {
        let shadowed = "\
28 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw
99 1 253:1 / / rw,relatime shared:1 - ext4 /dev/mapper/vg-root rw";
        let mounts = parse_mountinfo(shadowed);
        assert_eq!(root_mount(&mounts).unwrap().devno, "253:1");
        assert!(root_mount(&parse_mountinfo("")).is_none());
    }

    #[test]
    fn mount_points_are_unescaped() {
        let escaped = "28 1 8:2 / /mnt/my\\040disk rw,relatime - ext4 /dev/sdb1 rw";
        assert_eq!(parse_mountinfo(escaped)[0].mount_point, "/mnt/my disk");

        // Escapes encode UTF-8 bytes, and unrecognized sequences are kept.
        assert_eq!(unescape_mount_path("/mnt/caf\\303\\251"), "/mnt/café");
        assert_eq!(unescape_mount_path("/mnt/a\\b\\12"), "/mnt/a\\b\\12");
    }

    #[test]
    fn fixed_volume_filter_keeps_root_and_data_mounts() {
        let mounts = parse_mountinfo(ROOT_ON_LUKS);
        let fixed: Vec<&str> = mounts
            .iter()
            .filter(|m| is_fixed_volume_mount(m))
            .map(|m| m.mount_point.as_str())
            .collect();
        assert_eq!(fixed, vec!["/", "/data"]);
    }

    /// Minimal sysfs model with `dev/block` and `slaves` represented by relative
    /// symlinks.
    struct SysfsFixture {
        dir: tempfile::TempDir,
        dev_block: std::path::PathBuf,
        fs_btrfs: std::path::PathBuf,
    }

    impl SysfsFixture {
        fn new() -> SysfsFixture {
            let dir = tempfile::tempdir().unwrap();
            let dev_block = dir.path().join("dev").join("block");
            let fs_btrfs = dir.path().join("fs").join("btrfs");
            fs::create_dir_all(dir.path().join("devices")).unwrap();
            fs::create_dir_all(&dev_block).unwrap();
            fs::create_dir_all(&fs_btrfs).unwrap();
            SysfsFixture {
                dir,
                dev_block,
                fs_btrfs,
            }
        }

        fn root(&self) -> &Path {
            self.dir.path()
        }

        fn dev_block(&self) -> &Path {
            &self.dev_block
        }

        fn paths(&self) -> Sysfs<'_> {
            Sysfs {
                dev_block: &self.dev_block,
                fs_btrfs: &self.fs_btrfs,
            }
        }

        /// Registers a btrfs filesystem spanning `devices`, as the
        /// `/sys/fs/btrfs/<fsid>/devices/<name>` links do.
        fn btrfs(&self, fsid: &str, devices: &[&Path]) {
            let dir = self.fs_btrfs.join(fsid).join("devices");
            fs::create_dir_all(&dir).unwrap();
            for device in devices {
                let name = device.file_name().unwrap();
                symlink(relative(&dir, device), dir.join(name)).unwrap();
            }
        }

        fn disk(&self, name: &str, devno: Option<&str>) -> std::path::PathBuf {
            self.make_device(self.root().join("devices").join(name), devno)
        }

        fn partition(&self, disk: &str, name: &str, devno: &str) -> std::path::PathBuf {
            let parent = self.root().join("devices").join(disk);
            fs::create_dir_all(&parent).unwrap();
            self.make_device(parent.join(name), Some(devno))
        }

        fn mapper(&self, name: &str, devno: Option<&str>, uuid: &str) -> std::path::PathBuf {
            let dir = self.make_device(self.root().join("devices").join(name), devno);
            fs::create_dir_all(dir.join("dm")).unwrap();
            fs::write(dir.join("dm").join("uuid"), uuid).unwrap();
            dir
        }

        fn make_device(&self, dir: std::path::PathBuf, devno: Option<&str>) -> std::path::PathBuf {
            fs::create_dir_all(&dir).unwrap();
            if let Some(devno) = devno {
                fs::write(dir.join("dev"), format!("{}\n", devno)).unwrap();
                let link = self.dev_block().join(devno);
                symlink(relative(self.dev_block(), &dir), link).unwrap();
            }
            dir
        }

        fn slave(&self, dir: &Path, target: &Path) {
            let slaves = dir.join("slaves");
            fs::create_dir_all(&slaves).unwrap();
            let name = target.file_name().unwrap();
            symlink(relative(&slaves, target), slaves.join(name)).unwrap();
        }

        fn dangling_slave(&self, dir: &Path, name: &str) {
            let slaves = dir.join("slaves");
            fs::create_dir_all(&slaves).unwrap();
            symlink("../../gone", slaves.join(name)).unwrap();
        }
    }

    fn relative(from: &Path, to: &Path) -> std::path::PathBuf {
        let from: Vec<_> = from.components().collect();
        let to: Vec<_> = to.components().collect();
        let shared = from.iter().zip(&to).take_while(|(a, b)| a == b).count();

        let mut rel = std::path::PathBuf::new();
        for _ in shared..from.len() {
            rel.push("..");
        }
        for component in &to[shared..] {
            rel.push(component.as_os_str());
        }
        rel
    }

    #[test]
    fn plain_root_partition_is_unencrypted() {
        let sysfs = SysfsFixture::new();
        sysfs.partition("sda", "sda2", "8:2");

        let mountinfo = "28 1 8:2 / / rw,relatime - ext4 /dev/sda2 rw";
        let result = detect(&sysfs, mountinfo);
        assert_eq!(result.status.as_str(), "disabled");
        assert_eq!(result.method, Some("dm-crypt"));
    }

    #[test]
    fn root_directly_on_dm_crypt_is_encrypted() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));

        let mountinfo = "28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "full");
    }

    #[test]
    fn lvm_on_luks_root_is_encrypted_through_the_slaves_chain() {
        let sysfs = SysfsFixture::new();
        let lv = sysfs.mapper("dm-1", Some("253:1"), "LVM-abcdef-root\n");
        let crypt = sysfs.mapper("dm-0", None, "CRYPT-LUKS2-9a7b-luks\n");
        sysfs.slave(&lv, &crypt);
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));

        let mountinfo = "28 1 253:1 / / rw,relatime - ext4 /dev/mapper/vg-root rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "full");
    }

    #[test]
    fn a_verity_protected_root_is_not_encrypted() {
        let sysfs = SysfsFixture::new();
        // dm-verity shares the CRYPT- uuid prefix but stores plaintext.
        let verity = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-VERITY-4f1c-root\n");
        sysfs.slave(&verity, &sysfs.partition("sda", "sda2", "8:2"));

        let mountinfo = "28 1 253:0 / / ro,relatime - ext4 /dev/mapper/root ro";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "disabled");
    }

    #[test]
    fn integrity_only_devices_defer_to_the_storage_beneath_them() {
        let sysfs = SysfsFixture::new();
        let integrity = sysfs.mapper("dm-1", Some("253:1"), "CRYPT-INTEGRITY-root\n");
        let crypt = sysfs.mapper("dm-0", None, "CRYPT-LUKS2-9a7b-luks\n");
        sysfs.slave(&integrity, &crypt);
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));

        let mountinfo = "28 1 253:1 / / rw,relatime - ext4 /dev/mapper/root rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "full");
    }

    #[test]
    fn plaintext_storage_makes_the_stack_unencrypted() {
        let sysfs = SysfsFixture::new();
        let lv = sysfs.mapper("dm-1", Some("253:1"), "LVM-abcdef-root\n");
        let crypt = sysfs.mapper("dm-0", None, "CRYPT-LUKS2-9a7b-luks\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        sysfs.slave(&lv, &crypt);
        sysfs.slave(&lv, &sysfs.partition("sdb", "sdb1", "8:17"));

        let mountinfo = "28 1 253:1 / / rw,relatime - ext4 /dev/mapper/vg-root rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "disabled");
    }

    #[test]
    fn a_dangling_slave_makes_the_volume_unknown() {
        let sysfs = SysfsFixture::new();
        let lv = sysfs.mapper("dm-1", Some("253:1"), "LVM-abcdef-root\n");
        sysfs.dangling_slave(&lv, "sdb1");

        let mountinfo = "28 1 253:1 / / rw,relatime - ext4 /dev/mapper/vg-root rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "unknown");
    }

    #[test]
    fn plaintext_beneath_a_leg_outranks_an_unwalkable_one() {
        let sysfs = SysfsFixture::new();
        let lv = sysfs.mapper("dm-1", Some("253:1"), "LVM-abcdef-root\n");
        sysfs.slave(&lv, &sysfs.partition("sdb", "sdb1", "8:17"));
        sysfs.dangling_slave(&lv, "sdc1");

        let mountinfo = "28 1 253:1 / / rw,relatime - ext4 /dev/mapper/vg-root rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "disabled");
    }

    #[test]
    fn unknown_when_the_root_device_is_absent_from_sysfs() {
        let sysfs = SysfsFixture::new();

        let mountinfo = "28 1 8:2 / / rw,relatime - ext4 /dev/sda2 rw";
        let result = detect(&sysfs, mountinfo);
        assert_eq!(result.status.as_str(), "unknown");
        assert_eq!(result.method, None);

        assert_eq!(detect(&sysfs, "").status.as_str(), "unknown");
    }

    #[test]
    fn a_loop_backed_root_is_unknown() {
        let sysfs = SysfsFixture::new();
        // A snap-confined browser sees the base snap's squashfs as its root.
        let loop_dev = sysfs.disk("loop9", Some("7:9"));
        fs::create_dir_all(loop_dev.join("loop")).unwrap();
        fs::create_dir_all(loop_dev.join("slaves")).unwrap();

        let mountinfo = "28 1 7:9 / / ro,nodev,relatime - squashfs /dev/loop9 ro";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "unknown");
    }

    const BTRFS_ROOT: &str = "28 1 0:35 / / rw,relatime - btrfs /dev/mapper/root rw";

    #[test]
    fn a_btrfs_root_is_resolved_through_its_mount_source() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("root", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        sysfs.btrfs("4f1c-abcd", &[&crypt]);

        let result = detect(&sysfs, BTRFS_ROOT);
        assert_eq!(result.status.as_str(), "full");
        assert_eq!(result.method, Some("dm-crypt"));
    }

    #[test]
    fn a_btrfs_root_missing_from_sysfs_falls_back_to_the_named_device() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("root", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));

        // Kernels too old to list devices leave /sys/fs/btrfs empty.
        assert_eq!(detect(&sysfs, BTRFS_ROOT).status.as_str(), "full");
    }

    #[test]
    fn every_device_of_a_multi_device_btrfs_is_inspected() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("root", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        let plain = sysfs.partition("sdb", "sdb1", "8:17");
        sysfs.btrfs("4f1c-abcd", &[&crypt, &plain]);

        // The mount source names the encrypted half of the mirror only.
        assert_eq!(detect(&sysfs, BTRFS_ROOT).status.as_str(), "disabled");
    }

    #[test]
    fn an_unencrypted_btrfs_data_volume_makes_the_machine_partial() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        let data = sysfs.partition("sdb", "sdb1", "8:17");
        sysfs.btrfs("9a7b-ef01", &[&data]);

        let mountinfo = "\
28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw
45 28 0:36 / /data rw,relatime - btrfs /dev/sdb1 rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "partial");
    }

    #[test]
    fn a_btrfs_data_volume_with_an_unreadable_device_list_is_enabled() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        // The member is listed but its dev file cannot be read.
        let data = sysfs.disk("sdb1", None);
        sysfs.btrfs("9a7b-ef01", &[&data]);

        let mountinfo = "\
28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw
45 28 0:36 / /data rw,relatime - btrfs /dev/sdb1 rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "enabled");
    }

    #[test]
    fn subvolume_mounts_of_one_btrfs_are_inspected_once() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("root", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        sysfs.btrfs("4f1c-abcd", &[&crypt]);

        let mountinfo = "\
28 1 0:35 /@ / rw,relatime - btrfs /dev/mapper/root rw
45 28 0:35 /@home /home rw,relatime - btrfs /dev/mapper/root rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "full");
    }

    const ZFS_ROOT: &str = "28 1 0:40 / / rw,relatime - zfs rpool/ROOT/default rw";

    fn zfs_tables(encryption: &[(&str, &str)], vdevs: &[(&str, &[&str])]) -> ZfsTables {
        ZfsTables {
            encryption: encryption
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
            vdevs: vdevs
                .iter()
                .map(|(pool, paths)| {
                    (
                        pool.to_string(),
                        paths.iter().map(|p| p.to_string()).collect(),
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn a_natively_encrypted_zfs_root_reports_zfs_as_the_method() {
        let sysfs = SysfsFixture::new();
        let zfs = zfs_tables(&[("rpool/ROOT/default", "aes-256-gcm")], &[]);

        let result = detect_with(&sysfs, ZFS_ROOT, &[], &zfs);
        assert_eq!(result.status.as_str(), "full");
        assert_eq!(result.method, Some("zfs"));
    }

    #[test]
    fn a_zfs_pool_on_luks_is_encrypted_through_its_vdevs() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-pool\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        let zfs = zfs_tables(
            &[("rpool/ROOT/default", "off")],
            &[("rpool", &["/dev/mapper/dm-0"])],
        );

        let result = detect_with(&sysfs, ZFS_ROOT, &[], &zfs);
        assert_eq!(result.status.as_str(), "full");
        assert_eq!(result.method, Some("dm-crypt"));
    }

    #[test]
    fn a_plaintext_vdev_makes_the_zfs_pool_unencrypted() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-pool\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        sysfs.partition("sdb", "sdb1", "8:17");
        let zfs = zfs_tables(
            &[("rpool/ROOT/default", "off")],
            &[("rpool", &["/dev/mapper/dm-0", "/dev/sdb1"])],
        );

        assert_eq!(
            detect_with(&sysfs, ZFS_ROOT, &[], &zfs).status.as_str(),
            "disabled"
        );
    }

    #[test]
    fn a_zfs_root_is_unknown_without_tool_output() {
        let sysfs = SysfsFixture::new();

        assert_eq!(
            detect_with(&sysfs, ZFS_ROOT, &[], &ZfsTables::default())
                .status
                .as_str(),
            "unknown"
        );
    }

    #[test]
    fn zfs_properties_are_read_from_the_tab_separated_columns() {
        let output = "rpool\toff\nrpool/ROOT\taes-256-gcm\nrpool/home\t-\n";
        let encryption = parse_zfs_encryption(output);
        assert_eq!(encryption["rpool"], "off");
        assert_eq!(encryption["rpool/ROOT"], "aes-256-gcm");
        assert_eq!(encryption["rpool/home"], "-");
        assert!(parse_zfs_encryption("").is_empty());
    }

    #[test]
    fn zpool_vdev_paths_are_grouped_by_pool() {
        let output = "\
  pool: rpool
 state: ONLINE
config:

\tNAME                       STATE     READ WRITE CKSUM
\trpool                      ONLINE       0     0     0
\t  mirror-0                 ONLINE       0     0     0
\t    /dev/mapper/luks-root  ONLINE       0     0     0
\t    /dev/disk/by-id/x1     ONLINE       0     0     0

errors: No known data errors

  pool: tank
 state: ONLINE
config:

\tNAME          STATE     READ WRITE CKSUM
\ttank          ONLINE       0     0     0
\t  /dev/sdc1   ONLINE       0     0     0
\tcache
\t  /dev/sdd1   ONLINE       0     0     0
\tspares
\t  /dev/sde1   AVAIL

errors: No known data errors";

        let vdevs = parse_zpool_status(output);
        assert_eq!(
            vdevs["rpool"],
            ["/dev/mapper/luks-root", "/dev/disk/by-id/x1"]
        );
        assert_eq!(vdevs["tank"], ["/dev/sdc1", "/dev/sdd1"]);
        assert!(parse_zpool_status("no pools available").is_empty());
    }

    #[test]
    fn a_second_unencrypted_disk_makes_the_machine_partial() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        sysfs.partition("sdb", "sdb1", "8:17");

        let mountinfo = "\
28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw
45 28 8:17 / /data rw,relatime - ext4 /dev/sdb1 rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "partial");
    }

    #[test]
    fn boot_partitions_are_ignored() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        sysfs.partition("sda", "sda1", "8:1");
        sysfs.partition("sda", "sda2", "8:2");

        let mountinfo = "\
28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw
31 28 8:2 / /boot rw,relatime - ext2 /dev/sda2 rw
32 28 8:1 / /boot/efi rw,relatime - vfat /dev/sda1 rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "full");
    }

    #[test]
    fn evidence_gathered_before_the_deadline_is_kept() {
        let sysfs = SysfsFixture::new();
        let root = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&root, &sysfs.partition("sda", "sda3", "8:3"));
        sysfs.partition("sdb", "sdb1", "8:17");
        let home = sysfs.mapper("dm-1", Some("253:1"), "CRYPT-PLAIN-home\n");
        sysfs.slave(&home, &sysfs.partition("sdc", "sdc1", "8:33"));
        sysfs.partition("sdd", "sdd1", "8:49");

        // Attesting the root and then /home takes 400ms in total, so plaintext
        // /data is inspected but /srv is never reached.
        let mountinfo = "\
28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw
45 28 8:17 / /data rw,relatime - ext4 /dev/sdb1 rw
46 28 253:1 / /home rw,relatime - ext4 /dev/mapper/home rw
47 28 8:49 / /srv rw,relatime - ext4 /dev/sdd1 rw";
        let deadline = Instant::now() + Duration::from_millis(300);
        let slow_attestation = |_: &Path| {
            std::thread::sleep(Duration::from_millis(200));
            Some(true)
        };
        let result = detect_at(
            &sysfs.paths(),
            mountinfo,
            &[],
            &ZfsTables::default(),
            deadline,
            &slow_attestation,
        );
        assert_eq!(result.status.as_str(), "partial");

        let expired = Instant::now() - Duration::from_secs(1);
        let result = detect_at(
            &sysfs.paths(),
            mountinfo,
            &[],
            &ZfsTables::default(),
            expired,
            &|_| Some(true),
        );
        assert_eq!(result.status.as_str(), "enabled");
    }

    #[test]
    fn only_the_boot_mount_points_themselves_are_skipped() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        sysfs.partition("sda", "sda2", "8:2");
        sysfs.partition("sdb", "sdb1", "8:17");

        let mountinfo = "\
28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw
31 28 8:2 / /boot rw,relatime - ext2 /dev/sda2 rw
45 28 8:17 / /boot/data rw,relatime - ext4 /dev/sdb1 rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "partial");
    }

    #[test]
    fn swap_areas_are_read_from_the_first_column() {
        let swaps = "\
Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority
/dev/sda4                               partition\t8388604\t\t0\t\t-2
/swap\\040file                            file\t\t2097148\t\t0\t\t-3";
        assert_eq!(parse_swaps(swaps), ["/dev/sda4", "/swap file"]);
        assert!(parse_swaps("").is_empty());
        assert!(parse_swaps("Filename\tType\tSize\tUsed\tPriority\n").is_empty());
    }

    #[test]
    fn swap_paths_are_resolved_to_the_device_holding_them() {
        let dir = tempfile::tempdir().unwrap();
        let swapfile = dir.path().join("swapfile");
        fs::write(&swapfile, b"stand-in for a swap file").unwrap();

        let swaps = format!(
            "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n\
             {}\tfile\t2097148\t0\t-3\n\
             /var/gone\tfile\t2097148\t0\t-4",
            swapfile.display()
        );

        // Swap files use the containing filesystem's device number.
        let areas = swap_areas(&swaps);
        assert!(
            matches!(&areas[0], SwapArea::Device(devno) if *devno == devno_of(dir.path()).unwrap())
        );
        assert!(matches!(areas[1], SwapArea::Unresolved));
    }

    #[test]
    fn an_unresolvable_swap_area_makes_the_machine_enabled() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));

        let mountinfo = "28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw";
        assert_eq!(
            detect_with(
                &sysfs,
                mountinfo,
                &[SwapArea::Unresolved],
                &ZfsTables::default()
            )
            .status
            .as_str(),
            "enabled"
        );
    }

    #[test]
    fn dev_t_halves_are_recovered_from_both_bit_ranges() {
        // Match glibc's gnu_dev_makedev encoding.
        let makedev = |major: u64, minor: u64| {
            ((major & 0xfff) << 8)
                | (minor & 0xff)
                | ((major & !0xfff) << 32)
                | ((minor & !0xff) << 12)
        };

        for (major, minor) in [(8u64, 17u64), (253, 0), (0, 35), (259, 300), (4095, 255)] {
            let dev = makedev(major, minor);
            assert_eq!(
                (dev_major(dev) as u64, dev_minor(dev) as u64),
                (major, minor)
            );
        }
    }

    #[test]
    fn an_unencrypted_swap_partition_makes_the_machine_partial() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        sysfs.partition("sda", "sda4", "8:4");

        let mountinfo = "28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw";
        assert_eq!(
            detect_with(&sysfs, mountinfo, &swap_on("8:4"), &ZfsTables::default())
                .status
                .as_str(),
            "partial"
        );
    }

    #[test]
    fn zram_swap_is_ignored() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        sysfs.disk("zram0", Some("252:0"));

        let mountinfo = "28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw";
        assert_eq!(
            detect_with(&sysfs, mountinfo, &swap_on("252:0"), &ZfsTables::default())
                .status
                .as_str(),
            "full"
        );
    }

    #[test]
    fn swap_on_the_root_volume_is_deduplicated() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));

        // A swap file on the encrypted root reports the root's own devno.
        let mountinfo = "28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw";
        assert_eq!(
            detect_with(&sysfs, mountinfo, &swap_on("253:0"), &ZfsTables::default())
                .status
                .as_str(),
            "full"
        );
    }

    #[test]
    fn a_sweep_that_runs_out_of_time_preserves_enabled_status() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));
        sysfs.partition("sdb", "sdb1", "8:17");

        let mountinfo = "\
28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw
45 28 8:17 / /data rw,relatime - ext4 /dev/sdb1 rw";
        assert_eq!(
            detect_at(
                &sysfs.paths(),
                mountinfo,
                &[],
                &ZfsTables::default(),
                Instant::now(),
                &|_| Some(true),
            )
            .status
            .as_str(),
            "enabled"
        );
    }

    #[test]
    fn removable_media_is_ignored() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));

        // The flag lives on the whole disk, not the mounted partition.
        sysfs.partition("sdb", "sdb1", "8:17");
        fs::write(
            sysfs.root().join("devices").join("sdb").join("removable"),
            "1\n",
        )
        .unwrap();

        let mountinfo = "\
28 1 253:0 / / rw,relatime - ext4 /dev/mapper/root rw
45 28 8:17 / /media/usb rw,relatime - vfat /dev/sdb1 rw";
        assert_eq!(detect(&sysfs, mountinfo).status.as_str(), "full");
    }

    #[test]
    fn dm_crypt_table_rejects_null_ciphers() {
        assert_eq!(
            parse_dm_crypt_table("0 2097152 crypt aes-xts-plain64 :64:logon:key 0 8:3 4096\n"),
            Some(true)
        );
        assert_eq!(
            parse_dm_crypt_table("0 2097152 crypt cipher_null 00 0 8:3 0\n"),
            Some(false)
        );
        assert_eq!(
            parse_dm_crypt_table("0 2097152 crypt null-ecb 00 0 8:3 0\n"),
            Some(false)
        );
        assert_eq!(
            parse_dm_crypt_table("0 2097152 crypt capi:ecb(cipher_null)-plain64 00 0 8:3 0\n"),
            Some(false)
        );
        assert_eq!(
            parse_dm_crypt_table("0 2097152 crypt nullify-xts-plain64 00 0 8:3 0\n"),
            Some(true)
        );
        assert_eq!(
            parse_dm_crypt_table("0 2097152 linear 8:3 0\n"),
            Some(false)
        );
        assert_eq!(parse_dm_crypt_table(""), None);
        assert_eq!(parse_dm_crypt_table("0 2097152\n"), None);
    }

    #[test]
    fn plain_dm_crypt_mappings_are_attested() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-PLAIN-secret\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));

        assert_eq!(
            device_state(&sysfs.paths(), "253:0", &|_| Some(true)),
            VolumeState::Encrypted
        );
        assert_eq!(
            device_state(&sysfs.paths(), "253:0", &|_| Some(false)),
            VolumeState::Unencrypted
        );
        assert_eq!(
            device_state(&sysfs.paths(), "253:0", &|_| None),
            VolumeState::EncryptedUnverified
        );
    }

    #[test]
    fn luks_mappings_are_trusted_only_when_the_table_is_unreadable() {
        let sysfs = SysfsFixture::new();
        let crypt = sysfs.mapper("dm-0", Some("253:0"), "CRYPT-LUKS2-4f1c-root\n");
        sysfs.slave(&crypt, &sysfs.partition("sda", "sda3", "8:3"));

        assert_eq!(
            device_state(&sysfs.paths(), "253:0", &|_| None),
            VolumeState::Encrypted
        );
        assert_eq!(
            device_state(&sysfs.paths(), "253:0", &|_| Some(true)),
            VolumeState::Encrypted
        );
        assert_eq!(
            device_state(&sysfs.paths(), "253:0", &|_| Some(false)),
            VolumeState::Unencrypted
        );
    }
}
