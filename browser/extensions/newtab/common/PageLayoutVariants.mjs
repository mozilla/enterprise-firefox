/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  hasContentAreaWidgets,
  isWidgetsContainerVisible,
} from "./WidgetsRegistry.mjs";

/**
 * Newtab page layout variants. "Page layout" is the arrangement of the whole
 * newtab page, not a DiscoveryStream layout (see SectionsLayoutFeed and
 * selectLayoutRender, which are unrelated).
 *
 * The pref holds the layout's name rather than a set of feature booleans, so a
 * new layout is a new value here instead of a new pref, class prefix and metric.
 * The value is what newtab.page_layout_variant reports.
 */
export const PAGE_LAYOUT_VARIANTS = {
  NOVA_FULL_WIDTH: "nova-full-width",
  SIDE_BY_SIDE_CONTENT_LEAD: "side-by-side-content-lead",
  SIDE_BY_SIDE_WIDGETS_LEAD: "side-by-side-widgets-lead",
  SIDE_BY_SIDE_CONTENT_LEAD_FIVE: "side-by-side-content-lead-five",
  SIDE_BY_SIDE_WIDGETS_LEAD_FIVE: "side-by-side-widgets-lead-five",
};

export const DEFAULT_PAGE_LAYOUT_VARIANT = PAGE_LAYOUT_VARIANTS.NOVA_FULL_WIDTH;

/**
 * Band classes per side-by-side variant, keyed by variant name.
 *
 * Two orthogonal classes rather than the variant name itself, because CSS
 * matches classes per token: `.side-by-side-content-lead` would not match an
 * element classed `side-by-side-content-lead-five`, so every rule would need a
 * duplicate selector. The lead class carries the column order and every
 * side-by-side rule keys off it, so a variant and its -five counterpart share
 * one; side-by-side-five is what unlocks the fourth content card.
 *
 * "lead" is inline-start, so these stay correct in RTL.
 */
const SIDE_BY_SIDE_CLASSES = {
  [PAGE_LAYOUT_VARIANTS.SIDE_BY_SIDE_CONTENT_LEAD]: [
    "side-by-side-content-lead",
  ],
  [PAGE_LAYOUT_VARIANTS.SIDE_BY_SIDE_WIDGETS_LEAD]: [
    "side-by-side-widgets-lead",
  ],
  [PAGE_LAYOUT_VARIANTS.SIDE_BY_SIDE_CONTENT_LEAD_FIVE]: [
    "side-by-side-content-lead",
    "side-by-side-five",
  ],
  [PAGE_LAYOUT_VARIANTS.SIDE_BY_SIDE_WIDGETS_LEAD_FIVE]: [
    "side-by-side-widgets-lead",
    "side-by-side-five",
  ],
};

export const SIDE_BY_SIDE_PAGE_LAYOUTS = Object.keys(SIDE_BY_SIDE_CLASSES);

export const PREF_PAGE_LAYOUT_VARIANT = "pageLayouts.variant";

/**
 * Returns the assigned page layout variant, whether or not it can currently
 * render. This is the value telemetry reports.
 *
 * @param {object} prefs - current pref values from the Redux store
 * @returns {string}
 */
export function resolvePageLayoutVariant(prefs) {
  const trainhop = prefs?.trainhopConfig?.pageLayouts?.variant;
  if (typeof trainhop === "string" && trainhop) {
    return trainhop;
  }
  return prefs?.[PREF_PAGE_LAYOUT_VARIANT] || DEFAULT_PAGE_LAYOUT_VARIANT;
}

/**
 * Returns the classes the content band needs for the assigned variant, or an
 * empty array outside the experiment.
 *
 * @param {object} prefs - current pref values from the Redux store
 * @returns {string[]}
 */
export function sideBySideBandClasses(prefs) {
  return SIDE_BY_SIDE_CLASSES[resolvePageLayoutVariant(prefs)] ?? [];
}

/**
 * Returns true if a side-by-side variant is assigned, whether or not the page
 * can lay it out. The section panels key off this rather than isSideBySideActive,
 * so a lone section still gets its panel while in the experiment.
 *
 * @param {object} prefs - current pref values from the Redux store
 * @returns {boolean}
 */
export function isSideBySideAssigned(prefs) {
  return SIDE_BY_SIDE_PAGE_LAYOUTS.includes(resolvePageLayoutVariant(prefs));
}

/**
 * Returns true if a side-by-side variant is assigned and the page has both
 * things to put side by side. Without stories, or without a content-area widget,
 * the band falls back to its full-width single column.
 *
 * Use this rather than testing the variant directly, so the widgets gate stays
 * consistent with the rest of the page.
 *
 * @param {object} prefs - current pref values from the Redux store
 * @returns {boolean}
 */
export function isSideBySideActive(prefs) {
  return Boolean(
    SIDE_BY_SIDE_PAGE_LAYOUTS.includes(resolvePageLayoutVariant(prefs)) &&
    prefs?.["feeds.section.topstories"] &&
    prefs?.["feeds.system.topstories"] &&
    isWidgetsContainerVisible(prefs) &&
    hasContentAreaWidgets(prefs)
  );
}
