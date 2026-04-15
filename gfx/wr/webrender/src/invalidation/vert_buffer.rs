/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Quantized raster-space vertex buffer for output-space tile invalidation.
//!
//! Each primitive and clip gets its transformed, raster-space corners stored
//! here as quantized i32 values. The tile descriptor stores a VertRange
//! referencing into this buffer instead of a picture-space prim_clip_box or
//! spatial node dependency.

use api::units::*;
use crate::spatial_tree::{SpatialTree, SpatialNodeIndex, CoordinateSpaceMapping};
use crate::util::ScaleOffset;

/// Sub-pixel quantization scale: quarter-pixel precision.
pub const VERT_QUANTIZE_SCALE: f32 = 4.0;

pub fn quantize(v: f32) -> i32 {
    (v * VERT_QUANTIZE_SCALE).round() as i32
}

/// A reference into a per-tile vert_data buffer: offset (in i32 elements) and count.
/// count is 4 for an axis-aligned rect (2 corners × 2 coords) or 8 for a
/// non-axis-aligned quad (4 corners × 2 coords).
#[derive(Copy, Clone, Debug, Default, PartialEq, peek_poke::PeekPoke)]
#[cfg_attr(feature = "capture", derive(serde::Serialize))]
#[cfg_attr(feature = "replay", derive(serde::Deserialize))]
pub struct VertRange {
    pub offset: u32,
    pub count: u32,
}

impl VertRange {
    pub const INVALID: VertRange = VertRange { offset: 0, count: 0 };

    pub fn is_valid(self) -> bool {
        self.count > 0
    }
}

/// Persistent per-tile-cache scratch and transform cache for computing
/// raster-space corners.
///
/// Lives on TileCacheInstance and provides two optimisations:
///
/// 1. **Amortised unquantized scratch**: `unquantized` is never dropped between
///    frames, so the heap allocation is paid once after warmup.
///
/// 2. **Spatial-node transform cache**: the relative transform from
///    `prim_spatial_node` → `tile_cache_spatial_node` is cached so that
///    consecutive primitives in the same scroll frame avoid repeated
///    `get_relative_transform` calls.
pub struct CornersCache {
    /// Amortised scratch for unquantized corners.
    /// Cleared once before computing prim + coverage + clips for each primitive.
    unquantized: Vec<RasterPoint>,

    /// The primitive spatial node for which `cached_mapping` was computed.
    /// `None` means the cache is cold (reset at frame start).
    cached_node: Option<SpatialNodeIndex>,

    /// Cached mapping for `cached_node`. Valid only when
    /// `cached_node == Some(current prim_spatial_node)`.
    cached_mapping: CoordinateSpaceMapping<LayoutPixel, LayoutPixel>,
}

impl CornersCache {
    pub fn new() -> Self {
        CornersCache {
            unquantized: Vec::new(),
            cached_node: None,
            cached_mapping: CoordinateSpaceMapping::Local,
        }
    }

    /// Reset the transform cache. Call once at the start of each frame's
    /// dependency update, before any primitives are processed.
    pub fn pre_update(&mut self) {
        self.cached_node = None;
    }

    /// Clear the unquantized scratch. Call once before computing corners for a
    /// single primitive (before prim rect, coverage rect and all clips).
    pub fn clear_scratch(&mut self) {
        self.unquantized.clear();
    }

    /// Compute unquantized raster-space corners for `local_rect` and append
    /// them to the scratch buffer. Returns a VertRange into the scratch, or
    /// VertRange::INVALID if the transform is non-invertible.
    ///
    /// The relative transform for `prim_spatial_node` is cached across calls:
    /// if the same node is passed as the previous call, `get_relative_transform`
    /// is not recomputed.
    pub fn compute_to_scratch(
        &mut self,
        local_rect: LayoutRect,
        prim_spatial_node: SpatialNodeIndex,
        tile_cache_spatial_node: SpatialNodeIndex,
        local_to_raster: ScaleOffset,
        spatial_tree: &SpatialTree,
    ) -> VertRange {
        if Some(prim_spatial_node) != self.cached_node {
            let mapping = spatial_tree.get_relative_transform(
                prim_spatial_node,
                tile_cache_spatial_node,
            );
            self.cached_mapping = match mapping {
                CoordinateSpaceMapping::ScaleOffset(ref so) if so.is_reflection() => {
                    CoordinateSpaceMapping::Transform(so.to_transform())
                }
                other => other,
            };
            self.cached_node = Some(prim_spatial_node);
        }
        self.append_corners_from_mapping(local_rect, local_to_raster)
    }

    fn append_corners_from_mapping(
        &mut self,
        local_rect: LayoutRect,
        local_to_raster: ScaleOffset,
    ) -> VertRange {
        match &self.cached_mapping {
            CoordinateSpaceMapping::Local => {
                let r: RasterRect = local_to_raster.map_rect(&local_rect);
                let offset = self.unquantized.len() as u32;
                self.unquantized.push(r.min);
                self.unquantized.push(r.max);
                VertRange { offset, count: 2 }
            }
            CoordinateSpaceMapping::ScaleOffset(so) => {
                let r: RasterRect = so.then(&local_to_raster).map_rect(&local_rect);
                let offset = self.unquantized.len() as u32;
                self.unquantized.push(r.min);
                self.unquantized.push(r.max);
                VertRange { offset, count: 2 }
            }
            CoordinateSpaceMapping::Transform(m) => {
                let raster_m = m.then(&local_to_raster.to_transform::<LayoutPixel, RasterPixel>());
                let src = [
                    local_rect.min,
                    LayoutPoint::new(local_rect.max.x, local_rect.min.y),
                    LayoutPoint::new(local_rect.min.x, local_rect.max.y),
                    local_rect.max,
                ];
                let offset = self.unquantized.len() as u32;
                for p in &src {
                    match raster_m.transform_point2d(*p) {
                        Some(pt) => self.unquantized.push(pt),
                        None => {
                            self.unquantized.truncate(offset as usize);
                            return VertRange::INVALID;
                        }
                    }
                }
                VertRange { offset, count: 4 }
            }
        }
    }

    /// Quantize corners at `scratch_range` from the scratch buffer into `dst`.
    /// Returns a VertRange into `dst`, or INVALID if `scratch_range` is invalid.
    pub fn push_verts(&self, scratch_range: VertRange, dst: &mut Vec<i32>) -> VertRange {
        if !scratch_range.is_valid() {
            return VertRange::INVALID;
        }
        let start = scratch_range.offset as usize;
        let end = (scratch_range.offset + scratch_range.count) as usize;
        let corners = &self.unquantized[start..end];
        debug_assert!(corners.len() == 2 || corners.len() == 4);
        let offset = dst.len() as u32;
        for p in corners {
            dst.push(quantize(p.x));
            dst.push(quantize(p.y));
        }
        VertRange { offset, count: (corners.len() * 2) as u32 }
    }

    /// Quantize corners at `scratch_range` into `dst`, clamping to `tile_rect`.
    /// Returns a VertRange into `dst`, or INVALID if `scratch_range` is invalid.
    pub fn push_verts_clamped(
        &self,
        scratch_range: VertRange,
        tile_rect: &RasterRect,
        dst: &mut Vec<i32>,
    ) -> VertRange {
        if !scratch_range.is_valid() {
            return VertRange::INVALID;
        }
        let start = scratch_range.offset as usize;
        let end = (scratch_range.offset + scratch_range.count) as usize;
        let corners = &self.unquantized[start..end];
        debug_assert!(corners.len() == 2 || corners.len() == 4);
        let offset = dst.len() as u32;
        for p in corners {
            dst.push(quantize(p.x.max(tile_rect.min.x).min(tile_rect.max.x)));
            dst.push(quantize(p.y.max(tile_rect.min.y).min(tile_rect.max.y)));
        }
        VertRange { offset, count: (corners.len() * 2) as u32 }
    }
}
