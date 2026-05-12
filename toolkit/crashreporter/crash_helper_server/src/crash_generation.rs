/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

pub mod crash_annotations {
    include!(concat!(env!("OUT_DIR"), "/crash_annotations.rs"));
}
use super::{
    breakpad_crash_generator::BreakpadProcessId,
    phc::{self, StackTrace},
};

#[cfg(any(target_os = "android", target_os = "linux"))]
mod linux;
#[cfg(any(target_os = "android", target_os = "linux"))]
pub(crate) use linux::get_auxv_info;

#[cfg(target_os = "windows")]
mod windows;

use anyhow::{Context, Result};
use crash_annotations::{
    should_include_annotation, type_of_annotation, CrashAnnotation, CrashAnnotationType,
};
use crash_helper_common::{
    AsProcessReaderHandle, BreakpadChar, BreakpadString, GeckoChildId, Pid, ProcessHandle,
};
use mozannotation_server::{errors::AnnotationsRetrievalError, AnnotationData, CAnnotation};
use num_traits::FromPrimitive;
use std::{
    collections::HashMap,
    convert::TryInto,
    ffi::{c_char, c_void, CStr, CString, OsStr, OsString},
    fs::File,
    io::{Seek, SeekFrom, Write},
    mem::size_of,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Mutex,
};

pub(crate) struct CrashReport {
    pub(crate) path: OsString,
    pub(crate) error: Option<CString>,
}

impl CrashReport {
    fn new(path: &OsStr, error: &Option<CString>) -> CrashReport {
        CrashReport {
            path: path.to_owned(),
            error: error.to_owned(),
        }
    }
}

/******************************************************************************
 * Crash generator                                                            *
 ******************************************************************************/

#[derive(PartialEq)]
enum MinidumpOrigin {
    Breakpad,
    WindowsErrorReporting,
}

pub(crate) struct CrashGenerator
where
    // A reference to the `CrashGenerator` object is stored in the
    // `BreakpadContext` object and transferred in turn to the Breakpad crash
    // generation thread, so it needs to be `Send`.
    Self: Send,
{
    #[allow(unused)]
    minidump_path: OsString,
    main_process_handle: ProcessHandle,
    reports_by_pid: HashMap<Pid, Vec<CrashReport>>,
    reports_by_id: HashMap<GeckoChildId, CrashReport>,
}

impl CrashGenerator {
    pub(crate) fn new(
        main_process_handle: ProcessHandle,
        minidump_path: OsString,
    ) -> CrashGenerator {
        CrashGenerator {
            minidump_path,
            main_process_handle,
            reports_by_pid: HashMap::<Pid, Vec<CrashReport>>::new(),
            reports_by_id: HashMap::<GeckoChildId, CrashReport>::new(),
        }
    }

    pub(crate) fn set_path(&mut self, path: OsString) {
        self.minidump_path = path.clone();
    }

    pub(crate) fn move_report_to_id(&mut self, pid: Pid, id: GeckoChildId) {
        if let Some(crash_report) = self.retrieve_minidump_by_pid(pid) {
            self.reports_by_id.insert(id, crash_report);
        }
    }

    pub(crate) fn retrieve_minidump_by_pid(&mut self, pid: Pid) -> Option<CrashReport> {
        if let Some(mut entry) = self.reports_by_pid.remove(&pid) {
            let crash_report = entry.remove(0);

            if !entry.is_empty() {
                self.reports_by_pid.insert(pid, entry);
            }

            return Some(crash_report);
        }

        None
    }

    pub(crate) fn retrieve_minidump_by_id(&mut self, id: GeckoChildId) -> Option<CrashReport> {
        self.reports_by_id.remove(&id)
    }

    fn finalize_crash_report(
        &mut self,
        process_id: BreakpadProcessId,
        error: Option<CString>,
        minidump_path: &Path,
        origin: MinidumpOrigin,
    ) {
        let mut extra_path = PathBuf::from(minidump_path);
        extra_path.set_extension("extra");

        let annotations = retrieve_annotations(&process_id, origin);
        let global_annotations = self.retrieve_main_process_annotations();
        let annotations = merge_annotations(annotations.ok(), global_annotations.ok());
        let extra_file_written = write_extra_file(annotations, &extra_path).is_ok();

        let path = minidump_path.as_os_str();
        let error = if !extra_file_written {
            Some(CString::new("MissingAnnotations").unwrap())
        } else {
            error
        };

        let entry = self.reports_by_pid.entry(process_id.pid);
        entry
            .and_modify(|entry| entry.push(CrashReport::new(path, &error)))
            .or_insert_with(|| vec![CrashReport::new(path, &error)]);
    }

    fn retrieve_main_process_annotations(
        &self,
    ) -> Result<Vec<CAnnotation>, AnnotationsRetrievalError> {
        mozannotation_server::retrieve_annotations(
            self.main_process_handle.as_handle(),
            CrashAnnotation::Count as usize,
        )
    }
}

/******************************************************************************
 * Crash annotations                                                          *
 ******************************************************************************/

macro_rules! read_numeric_annotation {
    ($t:ty,$d:expr) => {
        if let AnnotationData::ByteBuffer(buff) = $d {
            if buff.len() == size_of::<$t>() {
                let value = buff.get(0..size_of::<$t>()).map(|bytes| {
                    let bytes: [u8; size_of::<$t>()] = bytes.try_into().unwrap();
                    <$t>::from_ne_bytes(bytes)
                });
                value.map(|value| value.to_string().into_bytes())
            } else {
                None
            }
        } else {
            None
        }
    };
}

fn write_phc_annotations(file: &mut File, buff: &[u8]) -> Result<()> {
    let addr_info = phc::AddrInfo::from_bytes(buff)?;
    if addr_info.kind == phc::Kind::Unknown {
        return Ok(());
    }

    write!(
        file,
        "\"PHCKind\":\"{}\",\
            \"PHCBaseAddress\":\"{}\",\
            \"PHCUsableSize\":\"{}\",",
        addr_info.kind_as_str(),
        addr_info.base_addr as usize,
        addr_info.usable_size,
    )?;

    if addr_info.alloc_stack.has_stack != 0 {
        write!(
            file,
            "\"PHCAllocStack\":\"{}\",",
            serialize_phc_stack(&addr_info.alloc_stack)
        )?;
    }

    if addr_info.free_stack.has_stack != 0 {
        write!(
            file,
            "\"PHCFreeStack\":\"{}\",",
            serialize_phc_stack(&addr_info.free_stack)
        )?;
    }

    Ok(())
}

fn serialize_phc_stack(stack_trace: &StackTrace) -> String {
    let mut string = String::new();
    for i in 0..stack_trace.length {
        string.push_str(&(stack_trace.pcs[i] as usize).to_string());
        string.push(',');
    }

    string.pop();
    string
}

/// This reads the crash annotations, writes them to the .extra file and
/// finally stores the resulting minidump in the global hash table.
///
/// # Safety
///
/// The caller must guarantee that the `generator` parameter points to a
/// Mutex<CrashGenerator> object and that `error_ptr` and `minidump_path_ptr`
/// point to valid strings.
pub(crate) unsafe extern "C" fn finalize_breakpad_minidump(
    generator: *const c_void,
    process_id: BreakpadProcessId,
    error_ptr: *const c_char,
    minidump_path_ptr: *const BreakpadChar,
) {
    let generator = generator as *const Mutex<CrashGenerator>;
    let minidump_path = PathBuf::from(<OsString as BreakpadString>::from_ptr(minidump_path_ptr));
    let error = if !error_ptr.is_null() {
        // SAFETY: The string is a valid C string we passed in ourselves.
        Some(CStr::from_ptr(error_ptr).to_owned())
    } else {
        None
    };

    let mut generator = generator.as_ref().unwrap().lock().unwrap();
    generator.finalize_crash_report(process_id, error, &minidump_path, MinidumpOrigin::Breakpad);
}

fn retrieve_annotations(
    process_id: &BreakpadProcessId,
    origin: MinidumpOrigin,
) -> Result<Vec<CAnnotation>> {
    let res = mozannotation_server::retrieve_annotations(
        process_id.get_native(),
        CrashAnnotation::Count as usize,
    );

    let mut annotations = res?;
    if origin == MinidumpOrigin::WindowsErrorReporting {
        annotations.push(CAnnotation {
            id: CrashAnnotation::WindowsErrorReporting as u32,
            data: AnnotationData::ByteBuffer(vec![1]),
        });
    }

    // Add a unique identifier for this crash event.
    let crash_id = uuid::Uuid::new_v4()
        .as_hyphenated()
        .encode_lower(&mut uuid::Uuid::encode_buffer())
        .to_string();
    annotations.push(CAnnotation {
        id: CrashAnnotation::CrashID as u32,
        data: AnnotationData::String(CString::new(crash_id).context("uuid contains nul byte")?),
    });

    Ok(annotations)
}

fn merge_annotations(
    child_process_annotations: Option<Vec<CAnnotation>>,
    main_process_annotations: Option<Vec<CAnnotation>>,
) -> HashMap<u32, AnnotationData> {
    let mut merged_annotations = HashMap::new();
    if let Some(annotations) = main_process_annotations {
        annotations
            .into_iter()
            .filter(|annotation| !matches!(annotation.data, AnnotationData::Empty))
            .for_each(|annotation| {
                let _ = merged_annotations.insert(annotation.id, annotation.data);
            });
    } else {
        merged_annotations.insert(
            CrashAnnotation::DumperError as u32,
            AnnotationData::String(CString::from_str("MissingMainProcessAnnotations").unwrap()),
        );
    }

    if let Some(annotations) = child_process_annotations {
        annotations
            .into_iter()
            .filter(|annotation| !matches!(annotation.data, AnnotationData::Empty))
            .for_each(|annotation| {
                let _ = merged_annotations
                    .entry(annotation.id)
                    .insert_entry(annotation.data);
            });
    } else {
        merged_annotations
            .entry(CrashAnnotation::DumperError as u32)
            .or_insert(AnnotationData::String(
                CString::from_str("MissingChildProcessAnnotations").unwrap(),
            ));
    }

    merged_annotations
}

fn write_extra_file(annotations: HashMap<u32, AnnotationData>, path: &Path) -> Result<()> {
    let mut annotations_written: usize = 0;
    let mut file = File::create(path)?;
    write!(&mut file, "{{")?;

    for (id, val) in annotations {
        if let Some(annotation_id) = CrashAnnotation::from_u32(id) {
            if annotation_id == CrashAnnotation::PHCBaseAddress {
                if let AnnotationData::ByteBuffer(buff) = &val {
                    write_phc_annotations(&mut file, buff)?;
                }

                continue;
            }

            let value = match type_of_annotation(annotation_id) {
                CrashAnnotationType::String => match &val {
                    AnnotationData::String(string) => Some(escape_value(string.as_bytes())),
                    AnnotationData::ByteBuffer(buffer) => Some(escape_value(buffer)),
                    _ => None,
                },
                CrashAnnotationType::Boolean => {
                    if let AnnotationData::ByteBuffer(buff) = &val {
                        if buff.len() == 1 {
                            Some(vec![if buff[0] != 0 { b'1' } else { b'0' }])
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                CrashAnnotationType::U32 => {
                    read_numeric_annotation!(u32, &val)
                }
                CrashAnnotationType::U64 => {
                    read_numeric_annotation!(u64, &val)
                }
                CrashAnnotationType::USize => {
                    read_numeric_annotation!(usize, &val)
                }
                CrashAnnotationType::Object => None, // This cannot be found in memory
            };

            if let Some(value) = value {
                if !value.is_empty() && should_include_annotation(annotation_id, &value) {
                    write!(&mut file, "\"{annotation_id:}\":\"")?;
                    file.write_all(&value)?;
                    write!(&mut file, "\",")?;
                    annotations_written += 1;
                }
            }
        }
    }

    if annotations_written > 0 {
        // Drop the last comma
        file.seek(SeekFrom::Current(-1))?;
    }
    writeln!(&mut file, "}}")?;
    Ok(())
}

// Escapes the characters of a crash annotation so that they appear correctly
// within the JSON output, escaping non-visible characters and the like. This
// does not try to make the output valid UTF-8 because the input might be
// corrupted so there's no point in that.
fn escape_value(input: &[u8]) -> Vec<u8> {
    let mut escaped = Vec::<u8>::with_capacity(input.len() + 2);
    for &c in input {
        if c <= 0x1f || c == b'\\' || c == b'"' {
            escaped.extend(b"\\u00");
            escaped.push(hex_digit_as_ascii_char((c & 0x00f0) >> 4));
            escaped.push(hex_digit_as_ascii_char(c & 0x000f));
        } else {
            escaped.push(c)
        }
    }

    escaped
}

fn hex_digit_as_ascii_char(value: u8) -> u8 {
    if value < 10 {
        b'0' + value
    } else {
        b'a' + (value - 10)
    }
}
