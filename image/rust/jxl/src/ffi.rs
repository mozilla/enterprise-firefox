/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use crate::decoder::JxlApiDecoder;
use std::slice;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum JxlDecoderStatus {
    Ok = 0,
    NeedMoreData = 1,
    Error = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct JxlBasicInfo {
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub alpha_premultiplied: bool,
    pub valid: bool,
}

#[no_mangle]
pub extern "C" fn jxl_decoder_new(metadata_only: bool) -> *mut JxlApiDecoder {
    Box::into_raw(Box::new(JxlApiDecoder::new(metadata_only)))
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_decoder_new` and must not
/// have been previously destroyed. After this call, `decoder` is invalid.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_destroy(decoder: *mut JxlApiDecoder) {
    if !decoder.is_null() {
        // SAFETY: Caller guarantees `decoder` is a valid pointer from `jxl_decoder_new`
        // and has not been destroyed. We take ownership and drop it.
        let _ = unsafe { Box::from_raw(decoder) };
    }
}

/// # Safety
/// - `decoder` must be a valid pointer returned by `jxl_decoder_new`.
/// - `data` must be a valid pointer to a `*const u8` pointer.
/// - `data_len` must be a valid pointer to a `usize`.
/// - `*data` must point to a valid byte slice of length `*data_len`.
/// - If `output_buffer` is non-null, it must point to a valid writable buffer
///   of at least `output_buffer_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_process_data(
    decoder: *mut JxlApiDecoder,
    data: *mut *const u8,
    data_len: *mut usize,
    output_buffer: *mut u8,
    output_buffer_len: usize,
) -> JxlDecoderStatus {
    assert!(!decoder.is_null() && !data.is_null() && !data_len.is_null());

    // SAFETY: Caller guarantees `decoder` is a valid, non-null pointer from `jxl_decoder_new`.
    let decoder = unsafe { &mut *decoder };

    // SAFETY: Caller guarantees `data` and `data_len` are valid pointers, and that
    // `*data` points to a valid byte slice of length `*data_len`.
    let mut data_slice = unsafe { slice::from_raw_parts(*data, *data_len) };

    let output_slice = if output_buffer.is_null() {
        None
    } else {
        // SAFETY: Caller guarantees that when `output_buffer` is non-null, it points
        // to a valid writable buffer of at least `output_buffer_len` bytes.
        Some(unsafe { slice::from_raw_parts_mut(output_buffer, output_buffer_len) })
    };

    let result = decoder.process_data(&mut data_slice, output_slice);

    // SAFETY: Caller guarantees `data` and `data_len` are valid, writable pointers.
    // We update them to reflect how much data was consumed.
    unsafe {
        *data = data_slice.as_ptr();
        *data_len = data_slice.len();
    }

    match result {
        Ok(true) => JxlDecoderStatus::Ok,
        Ok(false) => JxlDecoderStatus::NeedMoreData,
        Err(_) => JxlDecoderStatus::Error,
    }
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_decoder_new`.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_get_basic_info(decoder: *const JxlApiDecoder) -> JxlBasicInfo {
    assert!(!decoder.is_null());

    // SAFETY: Caller guarantees `decoder` is a valid, non-null pointer from `jxl_decoder_new`.
    let decoder = unsafe { &*decoder };

    let Some(info) = decoder.get_basic_info() else {
        return JxlBasicInfo::default();
    };

    JxlBasicInfo {
        width: info.width,
        height: info.height,
        has_alpha: info.has_alpha,
        alpha_premultiplied: info.alpha_premultiplied,
        valid: true,
    }
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_decoder_new`.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_is_frame_ready(decoder: *const JxlApiDecoder) -> bool {
    assert!(!decoder.is_null());

    // SAFETY: Caller guarantees `decoder` is a valid, non-null pointer from `jxl_decoder_new`.
    let decoder = unsafe { &*decoder };
    decoder.frame_ready
}
