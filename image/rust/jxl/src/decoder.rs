// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

use jxl::api::{
    JxlBitstreamInput, JxlColorType, JxlDataFormat, JxlDecoderInner, JxlDecoderOptions,
    JxlOutputBuffer, JxlPixelFormat, ProcessingResult,
};
use jxl::headers::extra_channels::ExtraChannel;

pub struct JxlApiDecoder {
    pub inner: JxlDecoderInner,
    metadata_only: bool,
    pixel_format_set: bool,
    pub frame_ready: bool,
}

pub struct BasicInfo {
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub alpha_premultiplied: bool,
}

#[derive(Debug)]
pub enum Error {
    JXL(jxl::error::Error),
    Overflow,
}

impl From<jxl::error::Error> for Error {
    fn from(err: jxl::error::Error) -> Error {
        Error::JXL(err)
    }
}

impl JxlApiDecoder {
    pub fn new(metadata_only: bool) -> Self {
        let options = JxlDecoderOptions::default();
        let inner = JxlDecoderInner::new(options);

        // Note: We don't set output_color_profile here because we don't have
        // CMS support yet. The CMS commit will add proper color management.
        // For now, output is in the image's native color space.

        Self {
            inner,
            metadata_only,
            pixel_format_set: false,
            frame_ready: false,
        }
    }

    pub fn get_basic_info(&self) -> Option<BasicInfo> {
        let basic_info = self.inner.basic_info()?;

        let alpha_channel = basic_info
            .extra_channels
            .iter()
            .find(|ec| ec.ec_type == ExtraChannel::Alpha);

        Some(BasicInfo {
            width: basic_info.size.0 as u32,
            height: basic_info.size.1 as u32,
            has_alpha: alpha_channel.is_some(),
            alpha_premultiplied: alpha_channel.is_some_and(|ec| ec.alpha_associated),
        })
    }

    pub fn process_data(
        &mut self,
        data: &mut impl JxlBitstreamInput,
        output_buffer: Option<&mut [u8]>,
    ) -> Result<bool, Error> {
        let has_output_buffer = output_buffer.is_some();

        // Create output buffer wrapper if provided.
        // When output_buffer is provided, dimensions must already be known.
        let (width, height) = self
            .inner
            .basic_info()
            .map(|bi| (bi.size.0, bi.size.1))
            .unwrap_or((0, 0));
        let bytes_per_row = width.checked_mul(4).ok_or(Error::Overflow)?;
        let mut output_buf: Option<JxlOutputBuffer<'_>> =
            output_buffer.map(|buf| JxlOutputBuffer::new(buf, height, bytes_per_row));

        loop {
            let result = self
                .inner
                .process(data, output_buf.as_mut().map(std::slice::from_mut));

            match result {
                Err(e) => {
                    return Err(e.into());
                }
                Ok(r) => match r {
                    ProcessingResult::Complete { .. } => {
                        let has_basic_info = self.inner.basic_info().is_some();

                        // For metadata-only decode, return as soon as we have basic_info
                        if self.metadata_only && has_basic_info {
                            return Ok(true);
                        }

                        if !self.pixel_format_set {
                            if let Some(basic_info) = self.inner.basic_info() {
                                let pixel_format = JxlPixelFormat {
                                    color_type: JxlColorType::Rgba,
                                    color_data_format: Some(JxlDataFormat::U8 { bit_depth: 8 }),
                                    extra_channel_format: vec![
                                        None;
                                        basic_info.extra_channels.len()
                                    ],
                                };
                                self.inner.set_pixel_format(pixel_format);
                                self.pixel_format_set = true;
                                // Continue processing - don't return, let jxl-rs continue
                                continue;
                            }
                        }

                        // Check if we have rendered a frame
                        if self.inner.frame_header().is_some() {
                            self.frame_ready = true;
                            // process() with a buffer should have consumed the frame header
                            assert!(!has_output_buffer, "frame_header present with output buffer");
                            return Ok(true);
                        } else if self.frame_ready {
                            // Frame was consumed (rendered to buffer)
                            self.frame_ready = false;
                            return Ok(true);
                        }
                        // No frame yet, need more data
                        return Ok(false);
                    }
                    ProcessingResult::NeedsMoreInput { .. } => {
                        return Ok(false);
                    }
                },
            }
        }
    }
}
