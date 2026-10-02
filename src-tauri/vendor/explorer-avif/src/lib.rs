//! Small owned interface to the pinned, bundled AVIF codec. C types stay here;
//! every returned native allocation is released on success and failure paths.
use std::ffi::{c_char, CStr};

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CropRect {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Metadata {
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub frame_count: u32,
    pub repetitions: i32,
    pub timescale: u64,
    pub frame_duration: u64,
    pub color_primaries: u32,
    pub transfer_function: u32,
    pub alpha_present: u32,
    pub max_cll: u32,
    pub max_pall: u32,
    pub aspect_horizontal: u32,
    pub aspect_vertical: u32,
    pub sequence_present: u32,
    pub gain_map_present: u32,
    pub gain_width: u32,
    pub gain_height: u32,
    pub gain_parameters: [u32; 43],
}

impl Default for Metadata {
    fn default() -> Self {
        Self {
            width: 0,
            height: 0,
            depth: 0,
            frame_count: 0,
            repetitions: 0,
            timescale: 0,
            frame_duration: 0,
            color_primaries: 0,
            transfer_function: 0,
            alpha_present: 0,
            max_cll: 0,
            max_pall: 0,
            aspect_horizontal: 0,
            aspect_vertical: 0,
            sequence_present: 0,
            gain_map_present: 0,
            gain_width: 0,
            gain_height: 0,
            gain_parameters: [0; 43],
        }
    }
}

#[repr(C)]
struct RawOutput {
    data: *mut u8,
    size: usize,
    metadata: Metadata,
    error: [c_char; 512],
}
impl Default for RawOutput {
    fn default() -> Self {
        Self {
            data: std::ptr::null_mut(),
            size: 0,
            metadata: Metadata::default(),
            error: [0; 512],
        }
    }
}

extern "C" {
    fn explorer_avif_is_avif(bytes: *const u8, size: usize) -> i32;
    fn explorer_avif_crop(
        bytes: *const u8,
        size: usize,
        crop: *const CropRect,
        output: *mut RawOutput,
    ) -> i32;
    fn explorer_avif_decode_frame(
        bytes: *const u8,
        size: usize,
        index: u32,
        output: *mut RawOutput,
    ) -> i32;
    fn explorer_avif_tone_map_frame(
        bytes: *const u8,
        size: usize,
        headroom: f32,
        output: *mut RawOutput,
    ) -> i32;
    fn explorer_avif_free(output: *mut RawOutput);
}

struct Output(RawOutput);
impl Drop for Output {
    fn drop(&mut self) {
        // The bridge only returns libavif allocations, transferred exactly
        // once into this owner. Its free accepts an empty output too.
        unsafe { explorer_avif_free(&mut self.0) };
    }
}

#[derive(Debug)]
pub struct DecodedFrame {
    pub pixels: Vec<u8>,
    pub metadata: Metadata,
}

fn collect(output: &Output, success: i32) -> Result<Vec<u8>, String> {
    if success == 0 {
        // The bridge initializes this fixed-size buffer and snprintf always
        // terminates it; the zero-initialized handle also covers early failures.
        return Err(unsafe { CStr::from_ptr(output.0.error.as_ptr()) }
            .to_string_lossy()
            .into_owned());
    }
    if output.0.data.is_null() || output.0.size == 0 || output.0.size > 256 * 1024 * 1024 {
        return Err("AVIF codec returned an invalid buffer".into());
    }
    // Borrow only while the native owner lives; the result never escapes with
    // native storage or references to the caller's input.
    let source = unsafe { std::slice::from_raw_parts(output.0.data, output.0.size) };
    let mut result = Vec::new();
    result
        .try_reserve_exact(source.len())
        .map_err(|error| error.to_string())?;
    result.extend_from_slice(source);
    Ok(result)
}

pub fn crop(bytes: &[u8], rect: CropRect) -> Result<Vec<u8>, String> {
    let mut output = Output(RawOutput::default());
    // Both slices and the geometry remain live for the synchronous native call;
    // the bridge validates bounds and retains neither pointer on return.
    let success = unsafe { explorer_avif_crop(bytes.as_ptr(), bytes.len(), &rect, &mut output.0) };
    collect(&output, success)
}

/// Recognizes both still AVIF and animated AVIS compatible file types.
pub fn is_avif(bytes: &[u8]) -> bool {
    unsafe { explorer_avif_is_avif(bytes.as_ptr(), bytes.len()) != 0 }
}

/// RGBA samples retain the source depth. Depths above8 use native-endian u16
/// components in their original10/12-bit range, rather than quantized u8 values.
pub fn decode_frame(bytes: &[u8], index: u32) -> Result<DecodedFrame, String> {
    let mut output = Output(RawOutput::default());
    let success =
        unsafe { explorer_avif_decode_frame(bytes.as_ptr(), bytes.len(), index, &mut output.0) };
    Ok(DecodedFrame {
        pixels: collect(&output, success)?,
        metadata: output.0.metadata,
    })
}

/// Tone-map the coded pixel canvas to linear half-float RGBA at a display headroom.
/// This decoder utility reports actual HDR reconstruction, including gain maps.
pub fn tone_map_frame(bytes: &[u8], headroom: f32) -> Result<DecodedFrame, String> {
    if !headroom.is_finite() || headroom < 0.0 {
        return Err("HDR headroom must be finite and nonnegative".into());
    }
    let mut output = Output(RawOutput::default());
    let success = unsafe {
        explorer_avif_tone_map_frame(bytes.as_ptr(), bytes.len(), headroom, &mut output.0)
    };
    Ok(DecodedFrame {
        pixels: collect(&output, success)?,
        metadata: output.0.metadata,
    })
}
