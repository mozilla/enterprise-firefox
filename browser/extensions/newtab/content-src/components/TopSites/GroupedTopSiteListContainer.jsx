/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import React, { useCallback, useMemo } from "react";
import { useDispatch } from "react-redux";
import { actionCreators as ac, actionTypes as at } from "common/Actions.mjs";
import { TopSiteList } from "./TopSite";
import { buildTopSitesList } from "./TopSiteListContainer";
import { isSponsored, TOP_SITES_SOURCE } from "./TopSitesConstants";
import { useTopSitesDnD } from "./useTopSitesDnD.jsx";
import { useZeroPinDrop } from "./useZeroPinDrop.jsx";

// Grouped reorder uses the classic DnD hook: `isShiftable = isPinned` already
// slides the pinned block, and the constant-cell preview already grows the block
// when a frecent joins — natively, no geometry. Grouping itself (contiguity, the
// drop-zone box) lives in the feed and PinnedAreaOverlay, not here.
const isMovable = site =>
  !site.isPinned && !isSponsored(site) && !site.isAddButton;
const isShiftable = site => !!site.isPinned;

// The TOP_SITES_INSERT + telemetry dispatch both grouped variants commit on a
// drop. Identical shape to the classic container's, kept domain-side here.
function useGroupedInsert() {
  const dispatch = useDispatch();

  const onDragStart = useCallback(
    index =>
      dispatch(
        ac.UserEvent({
          event: "DRAG",
          source: TOP_SITES_SOURCE,
          action_position: index,
        })
      ),
    [dispatch]
  );

  const onReorder = useCallback(
    ({ site, title, fromIndex, toIndex }) => {
      dispatch(
        ac.AlsoToMain({
          type: at.TOP_SITES_INSERT,
          data: {
            site: {
              url: site.url,
              label: title,
              customScreenshotURL: site.customScreenshotURL,
              ...(site.searchTopSite && { searchTopSite: true }),
            },
            index: toIndex,
            draggedFromIndex: fromIndex,
          },
        })
      );
      dispatch(
        ac.UserEvent({
          event: "DROP",
          source: TOP_SITES_SOURCE,
          action_position: toIndex,
        })
      );
    },
    [dispatch]
  );

  return { onDragStart, onReorder };
}

function useBaseSites(props) {
  return useMemo(
    () =>
      buildTopSitesList(
        props.TopSites.rows,
        props.TopSitesRows,
        props.topSitesMaxSitesPerRow
      ),
    [props.TopSites.rows, props.TopSitesRows, props.topSitesMaxSitesPerRow]
  );
}

// At least one pin present: a drag reorders within / joins the contiguous group.
function ReorderTopSiteListContainer(props) {
  const baseSites = useBaseSites(props);
  const { onDragStart, onReorder } = useGroupedInsert();

  const { previewSites, onDragEvent, draggedSite } = useTopSitesDnD({
    baseSites,
    rows: props.TopSites.rows,
    isMovable,
    isShiftable,
    onDragStart,
    onReorder,
    pinInPlace: true,
  });

  return (
    <TopSiteList
      {...props}
      sites={previewSites || baseSites}
      onDragEvent={onDragEvent}
      draggedSite={draggedSite}
      groupedPinsEnabled={true}
    />
  );
}

// No pins yet: a drag just pins one tile at the front of a fresh group.
function ZeroPinTopSiteListContainer(props) {
  const baseSites = useBaseSites(props);
  const { onDragStart, onReorder } = useGroupedInsert();

  const { sites, onDragEvent, draggedSite, listProps, decorations } =
    useZeroPinDrop({ baseSites, isSponsored, onDragStart, onReorder });

  return (
    <TopSiteList
      {...props}
      sites={sites}
      onDragEvent={onDragEvent}
      draggedSite={draggedSite}
      groupedPinsEnabled={true}
      listProps={listProps}
      decorations={decorations}
    />
  );
}

// Routes to the right grouped DnD variant. Zero existing pins is a fundamentally
// simpler interaction (drag one tile onto one target), so it gets its own hook;
// with pins present it's slot reordering. `hasPins` only flips on a pin/unpin
// commit (never mid-drag), so swapping containers here is safe.
export function GroupedTopSiteListContainer(props) {
  const hasPins = props.TopSites.rows.some(site => site?.isPinned);
  return hasPins ? (
    <ReorderTopSiteListContainer {...props} />
  ) : (
    <ZeroPinTopSiteListContainer {...props} />
  );
}
