/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { actionCreators as ac, actionTypes as at } from "common/Actions.mjs";
import {
  isSponsored,
  MIN_RICH_FAVICON_SIZE,
  MIN_SMALL_FAVICON_SIZE,
  SPOC_TYPE,
  TOP_SITES_CONTEXT_MENU_OPTIONS,
  TOP_SITES_SPOC_CONTEXT_MENU_OPTIONS,
  TOP_SITES_SPONSORED_POSITION_CONTEXT_MENU_OPTIONS,
  TOP_SITES_SEARCH_SHORTCUTS_CONTEXT_MENU_OPTIONS,
  TOP_SITES_SOURCE,
} from "./TopSitesConstants";
import { PinnedAreaOverlay } from "./PinnedAreaOverlay.jsx";
import { LinkMenu } from "content-src/components/LinkMenu/LinkMenu";
import { ImpressionStats } from "../DiscoveryStreamImpressionStats/ImpressionStats";
import React from "react";
import { ScreenshotUtils } from "content-src/lib/screenshot-utils";
import { TOP_SITES_MAX_SITES_PER_ROW } from "common/Reducers.sys.mjs";
import { ContextMenuButton } from "content-src/components/ContextMenu/ContextMenuButton";
import { TopSiteImpressionWrapper } from "./TopSiteImpressionWrapper";
import { connect } from "react-redux";
import { MessageWrapper } from "../MessageWrapper/MessageWrapper";
import { ShortcutFeatureHighlight } from "../DiscoveryStreamComponents/FeatureHighlight/ShortcutFeatureHighlight";
import { shouldShowOMCHighlight } from "../../lib/asrouter-message-utils.mjs";

const NEWTAB_SOURCE = "newtab";

// Tilt so the lifted drag ghost reads as "picked up" (counter-clockwise).
const DRAG_GHOST_ROTATION_DEG = -7.5;
// Cursor relative to the ghost's top edge; negative = cursor sits just above it.
const DRAG_GHOST_CURSOR_INSET = -12;

/**
 * Clones the dragged tile, styles it (size + rotation, pin/menu chrome hidden via
 * `.drag-ghost`), and hands it to native setDragImage so the platform draws and
 * follows it. Mounted off-screen under the tile's parent to keep the cascade.
 * Caller MUST call destroy() on dragend.
 */
function createDragGhost(e, el) {
  const restingSize = Math.round(el.getBoundingClientRect().width);
  const mountPoint = el.parentElement || document.body;

  const clone = el.cloneNode(true);
  clone.classList.add("drag-ghost", "active");
  // Drop any open context menu from the clone so only the tile is lifted.
  clone.querySelector(".context-menu")?.remove();
  // Size the ghost to the hover/expanded tile (--col-width, per Figma), falling
  // back to the resting size where that token isn't defined.
  clone.style.cssText = `position:fixed;top:-9999px;left:-9999px;width:var(--col-width, ${restingSize}px);height:var(--col-width, ${restingSize}px);margin:0;pointer-events:none;transform:rotate(${DRAG_GHOST_ROTATION_DEG}deg)`;
  mountPoint.appendChild(clone);

  // offsetWidth is the layout width, unaffected by the rotate transform.
  e.dataTransfer.setDragImage(
    clone,
    clone.offsetWidth / 2,
    DRAG_GHOST_CURSOR_INSET
  );

  return {
    destroy() {
      clone.remove();
    },
  };
}

export class TopSiteLink extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = { screenshotImage: null };
    this.onDragEvent = this.onDragEvent.bind(this);
    this.onKeyPress = this.onKeyPress.bind(this);
  }

  /*
   * Helper to determine whether the drop zone should allow a drop. We only allow
   * dropping top sites for now. We don't allow dropping on sponsored top sites
   * or the add shortcut button as their position is fixed.
   */
  _allowDrop(e) {
    if (!e.dataTransfer.types.includes("text/topsite-index")) {
      return false;
    }
    // Grouped reorder is bounded to the pinned block: only pinned tiles are
    // valid drop targets, so a tile can't be dropped out into the frecent area.
    if (this.props.groupedPinsEnabled) {
      return !!this.props.link.isPinned;
    }
    return (
      this.dragged || (!isSponsored(this.props.link) && !this.props.isAddButton)
    );
  }

  onDragEvent(event) {
    switch (event.type) {
      case "click":
        // Stop any link clicks if we started any dragging
        if (this.dragged) {
          event.preventDefault();
        }
        break;
      case "dragstart":
        event.target.blur();
        if (isSponsored(this.props.link)) {
          event.preventDefault();
          break;
        }
        this.dragged = true;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/topsite-index", this.props.index);
        if (this.props.groupedPinsEnabled) {
          // Lift a styled clone (rotated, hover-sized) as the drag image.
          this._dragGhost = createDragGhost(event, event.currentTarget);
        }
        this.props.onDragEvent(
          event,
          this.props.index,
          this.props.link,
          this.props.title
        );
        break;
      case "dragend":
        this._dragGhost?.destroy();
        this._dragGhost = null;
        this.props.onDragEvent(event);
        break;
      case "dragenter":
      case "dragover":
      case "drop":
        if (this._allowDrop(event)) {
          event.preventDefault();
          this.props.onDragEvent(event, this.props.index);
        }
        break;
      case "mousedown":
        // Block the scroll wheel from appearing for middle clicks on search top sites
        if (event.button === 1 && this.props.link.searchTopSite) {
          event.preventDefault();
        }
        // Reset at the first mouse event of a potential drag
        this.dragged = false;
        break;
    }
  }

  static getDerivedStateFromProps(nextProps, prevState) {
    const { screenshot } = nextProps.link;
    const imageInState = ScreenshotUtils.isRemoteImageLocal(
      prevState.screenshotImage,
      screenshot
    );
    if (imageInState) {
      return null;
    }

    // Since image was updated, attempt to revoke old image blob URL, if it exists.
    ScreenshotUtils.maybeRevokeBlobObjectURL(prevState.screenshotImage);

    return {
      screenshotImage: ScreenshotUtils.createLocalImageObject(screenshot),
    };
  }

  componentWillUnmount() {
    ScreenshotUtils.maybeRevokeBlobObjectURL(this.state.screenshotImage);
  }

  onKeyPress(event) {
    // If we have tabbed to a search shortcut top site, and we click 'enter',
    // we should execute the onClick function. This needs to be added because
    // search top sites are anchor tags without an href. See bug 1483135
    if (
      event.key === "Enter" &&
      (this.props.link.searchTopSite || this.props.isAddButton)
    ) {
      this.props.onClick(event);
    }
  }

  /*
   * Takes the url as a string, runs it through a simple (non-secure) hash turning it into a random number
   * Apply that random number to the color array. The same url will always generate the same color.
   */
  generateColor() {
    let { title, colors } = this.props;
    if (!colors) {
      return "";
    }

    let colorArray = colors.split(",");

    const hashStr = str => {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        let charCode = str.charCodeAt(i);
        hash += charCode;
      }
      return hash;
    };

    let hash = hashStr(title);
    let index = hash % colorArray.length;
    return colorArray[index];
  }

  calculateStyle() {
    const { defaultStyle, link } = this.props;

    const { tippyTopIcon, faviconSize } = link;
    let imageClassName;
    let imageStyle;
    let showSmallFavicon = false;
    let smallFaviconStyle;
    let hasScreenshotImage =
      this.state.screenshotImage && this.state.screenshotImage.url;
    let selectedColor;

    if (defaultStyle) {
      // force no styles (letter fallback) even if the link has imagery
      selectedColor = this.generateColor();
    } else if (link.searchTopSite) {
      imageClassName = "top-site-icon rich-icon";
      imageStyle = {
        backgroundColor: link.backgroundColor,
        backgroundImage: `url(${tippyTopIcon})`,
      };
      smallFaviconStyle = { backgroundImage: `url(${tippyTopIcon})` };
    } else if (link.customScreenshotURL) {
      // assume high quality custom screenshot and use rich icon styles and class names
      imageClassName = "top-site-icon rich-icon";
      imageStyle = {
        backgroundColor: link.backgroundColor,
        backgroundImage: hasScreenshotImage
          ? `url(${this.state.screenshotImage.url})`
          : "",
      };
    } else if (
      tippyTopIcon ||
      link.type === SPOC_TYPE ||
      faviconSize >= MIN_RICH_FAVICON_SIZE
    ) {
      // styles and class names for top sites with rich icons
      imageClassName = "top-site-icon rich-icon";
      imageStyle = {
        backgroundColor: link.backgroundColor,
        backgroundImage: `url(${tippyTopIcon || link.favicon})`,
      };
    } else if (faviconSize >= MIN_SMALL_FAVICON_SIZE) {
      showSmallFavicon = true;
      smallFaviconStyle = { backgroundImage: `url(${link.favicon})` };
    } else {
      selectedColor = this.generateColor();
      imageClassName = "";
    }

    return {
      showSmallFavicon,
      smallFaviconStyle,
      imageStyle,
      imageClassName,
      selectedColor,
    };
  }

  render() {
    const {
      children,
      className,
      isDraggable,
      link,
      onClick,
      title,
      isAddButton,
      visibleTopSites,
    } = this.props;

    const topSiteOuterClassName = `top-site-outer${
      className ? ` ${className}` : ""
    }${link.isDragged ? " dragged" : ""}${
      link.isCollapsed ? " collapsed" : ""
    }${link.searchTopSite ? " search-shortcut" : ""}`;
    const [letterFallback] = title;
    const {
      showSmallFavicon,
      smallFaviconStyle,
      imageStyle,
      imageClassName,
      selectedColor,
    } = this.calculateStyle();

    const addButtonLabell10n = {
      "data-l10n-id": "newtab-topsites-add-shortcut-label",
    };
    const addButtonTitlel10n = {
      "data-l10n-id": "newtab-topsites-add-shortcut-title",
    };
    const addPinnedTitlel10n = {
      "data-l10n-id": "topsite-label-pinned",
      "data-l10n-args": JSON.stringify({ title }),
    };

    let draggableProps = {};
    if (isDraggable) {
      draggableProps = {
        onClick: this.onDragEvent,
        onDragEnd: this.onDragEvent,
        onDragStart: this.onDragEvent,
        onMouseDown: this.onDragEvent,
      };
    }

    let impressionStats = null;
    if (link.type === SPOC_TYPE) {
      // Record impressions for Pocket tiles.
      impressionStats = (
        <ImpressionStats
          flightId={link.flightId}
          rows={[
            {
              id: link.id,
              pos: link.pos,
              shim: link.shim && link.shim.impression,
              advertiser: title.toLocaleLowerCase(),
            },
          ]}
          dispatch={this.props.dispatch}
          source={TOP_SITES_SOURCE}
        />
      );
    } else if (isSponsored(link)) {
      // Record impressions for non-Pocket sponsored tiles.
      impressionStats = (
        <TopSiteImpressionWrapper
          actionType={at.TOP_SITES_SPONSORED_IMPRESSION_STATS}
          tile={{
            position: this.props.index,
            tile_id: link.sponsored_tile_id || -1,
            reporting_url: link.sponsored_impression_url,
            advertiser: title.toLocaleLowerCase(),
            source: NEWTAB_SOURCE,
            visible_topsites: visibleTopSites,
            frecency_boosted: link.type === "frecency-boost",
            attribution: link.attribution,
          }}
          // For testing.
          IntersectionObserver={this.props.IntersectionObserver}
          document={this.props.document}
          dispatch={this.props.dispatch}
        />
      );
    } else {
      // Record impressions for organic tiles.
      impressionStats = (
        <TopSiteImpressionWrapper
          actionType={at.TOP_SITES_ORGANIC_IMPRESSION_STATS}
          tile={{
            position: this.props.index,
            source: NEWTAB_SOURCE,
            isPinned: this.props.link.isPinned,
            guid: this.props.link.guid,
            visible_topsites: visibleTopSites,
            smartScores: this.props.link.scores,
            smartWeights: this.props.link.weights,
          }}
          // For testing.
          IntersectionObserver={this.props.IntersectionObserver}
          document={this.props.document}
          dispatch={this.props.dispatch}
        />
      );
    }

    return (
      <li
        className={topSiteOuterClassName}
        ref={this.props.setRef}
        {...(this.props.groupedPinsEnabled && {
          // The drop-zone overlay measures the pinned block by data-index.
          "data-index": this.props.index,
        })}
        {...(!this.props.dropsOnList && {
          // Per-tile drop targets (classic + grouped reorder). Zero-pin moves
          // these to the list, since it has a single synthetic target.
          onDrop: this.onDragEvent,
          onDragOver: this.onDragEvent,
          onDragEnter: this.onDragEvent,
          onDragLeave: this.onDragEvent,
        })}
        {...draggableProps}
      >
        <div className="top-site-inner">
          {/* We don't yet support an accessible drag-and-drop implementation, see Bug 1552005 */}
          {/* eslint-disable-next-line jsx-a11y/anchor-is-valid */}
          <a
            className="top-site-button"
            href={link.searchTopSite ? undefined : link.url}
            tabIndex={this.props.tabIndex}
            onKeyPress={this.onKeyPress}
            onClick={onClick}
            draggable={true}
            data-is-sponsored-link={!!link.sponsored_tile_id}
            onFocus={this.props.onFocus}
            aria-label={link.isPinned ? undefined : title}
            {...(isAddButton && { ...addButtonTitlel10n })}
            {...(!isAddButton && { title })}
            {...(link.isPinned && { ...addPinnedTitlel10n })}
            data-l10n-args={JSON.stringify({ title })}
          >
            <div className="tile" aria-hidden={true}>
              <div
                className={
                  selectedColor
                    ? "icon-wrapper letter-fallback"
                    : "icon-wrapper"
                }
                data-fallback={letterFallback}
                style={selectedColor ? { backgroundColor: selectedColor } : {}}
              >
                <div className={imageClassName} style={imageStyle} />
                {showSmallFavicon && (
                  <div
                    className="top-site-icon default-icon"
                    data-fallback={smallFaviconStyle ? "" : letterFallback}
                    style={smallFaviconStyle}
                  />
                )}
              </div>
            </div>
            {link.isPinned && <div className="icon icon-pin-small" />}
            <div
              className={`title${link.isPinned ? " has-icon pinned" : ""}${
                link.type === SPOC_TYPE || link.show_sponsored_label
                  ? " sponsored"
                  : ""
              }`}
            >
              <span
                className="title-label"
                dir="auto"
                {...(isAddButton && { ...addButtonLabell10n })}
              >
                {link.searchTopSite && (
                  <div className="top-site-icon search-topsite" />
                )}
                {title}
              </span>
              <span
                className="sponsored-label"
                data-l10n-id="newtab-topsite-sponsored"
              />
            </div>
          </a>
          {isAddButton &&
            shouldShowOMCHighlight(
              this.props.Messages,
              "ShortcutHighlight"
            ) && (
              <MessageWrapper
                dispatch={this.props.dispatch}
                onClick={e => e.stopPropagation()}
              >
                <ShortcutFeatureHighlight
                  dispatch={this.props.dispatch}
                  feature="FEATURE_SHORTCUT_HIGHLIGHT"
                  position="inset-block-end inset-inline-start"
                  messageData={this.props.Messages?.messageData}
                />
              </MessageWrapper>
            )}
          {children}
          {impressionStats}
        </div>
      </li>
    );
  }
}
TopSiteLink.defaultProps = {
  title: "",
  link: {},
  isDraggable: true,
};

export class TopSite extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = { showContextMenu: false };
    this.onLinkClick = this.onLinkClick.bind(this);
    this.onMenuUpdate = this.onMenuUpdate.bind(this);
  }

  /**
   * Report to telemetry additional information about the item.
   */
  _getTelemetryInfo() {
    const value = { icon_type: this.props.link.iconType };
    // Filter out "not_pinned" type for being the default
    if (this.props.link.isPinned) {
      value.card_type = "pinned";
    }
    if (this.props.link.searchTopSite) {
      // Set the card_type as "search" regardless of its pinning status
      value.card_type = "search";
      value.search_vendor = this.props.link.hostname;
    }
    if (isSponsored(this.props.link)) {
      value.card_type = "spoc";
    }
    return { value };
  }

  userEvent(event) {
    this.props.dispatch(
      ac.UserEvent(
        Object.assign(
          {
            event,
            source: TOP_SITES_SOURCE,
            action_position: this.props.index,
          },
          this._getTelemetryInfo()
        )
      )
    );
  }

  onLinkClick(event) {
    this.userEvent("CLICK");

    // Specially handle a top site link click for "typed" frecency bonus as
    // specified as a property on the link.
    event.preventDefault();
    const { altKey, button, ctrlKey, metaKey, shiftKey } = event;
    if (!this.props.link.searchTopSite) {
      this.props.dispatch(
        ac.OnlyToMain({
          type: at.OPEN_LINK,
          data: Object.assign(this.props.link, {
            event: { altKey, button, ctrlKey, metaKey, shiftKey },
            is_sponsored: !!this.props.link.sponsored_tile_id,
          }),
        })
      );

      if (this.props.link.type === SPOC_TYPE) {
        // Record a Pocket-specific click.
        this.props.dispatch(
          ac.ImpressionStats({
            source: TOP_SITES_SOURCE,
            click: 0,
            tiles: [
              {
                id: this.props.link.id,
                pos: this.props.link.pos,
                shim: this.props.link.shim && this.props.link.shim.click,
              },
            ],
          })
        );

        // Record a click for a Pocket sponsored tile.
        // This first event is for the shim property
        // and is used by our ad service provider.
        this.props.dispatch(
          ac.DiscoveryStreamUserEvent({
            event: "CLICK",
            source: TOP_SITES_SOURCE,
            action_position: this.props.link.pos,
            value: {
              card_type: "spoc",
              tile_id: this.props.link.id,
              shim: this.props.link.shim && this.props.link.shim.click,
              attribution: this.props.link.attribution,
            },
          })
        );

        // A second event is recoded for internal usage.
        const title = this.props.link.label || this.props.link.hostname;
        this.props.dispatch(
          ac.OnlyToMain({
            type: at.TOP_SITES_SPONSORED_IMPRESSION_STATS,
            data: {
              type: "click",
              position: this.props.link.pos,
              tile_id: this.props.link.id,
              advertiser: title.toLocaleLowerCase(),
              source: NEWTAB_SOURCE,
              attribution: this.props.link.attribution,
            },
          })
        );
      } else if (isSponsored(this.props.link)) {
        // Record a click for a non-Pocket sponsored tile.
        const title = this.props.link.label || this.props.link.hostname;
        this.props.dispatch(
          ac.OnlyToMain({
            type: at.TOP_SITES_SPONSORED_IMPRESSION_STATS,
            data: {
              type: "click",
              position: this.props.index,
              tile_id: this.props.link.sponsored_tile_id || -1,
              reporting_url: this.props.link.sponsored_click_url,
              advertiser: title.toLocaleLowerCase(),
              source: NEWTAB_SOURCE,
              visible_topsites: this.props.visibleTopSites,
              frecency_boosted: this.props.link.type === "frecency-boost",
              attribution: this.props.link.attribution,
            },
          })
        );
      } else {
        // Record a click for an organic tile.
        this.props.dispatch(
          ac.OnlyToMain({
            type: at.TOP_SITES_ORGANIC_IMPRESSION_STATS,
            data: {
              type: "click",
              position: this.props.index,
              source: NEWTAB_SOURCE,
              isPinned: this.props.link.isPinned,
              guid: this.props.link.guid,
              visible_topsites: this.props.visibleTopSites,
              smartScores: this.props.link.scores,
              smartWeights: this.props.link.weights,
            },
          })
        );
      }

      if (this.props.link.sendAttributionRequest) {
        this.props.dispatch(
          ac.OnlyToMain({
            type: at.PARTNER_LINK_ATTRIBUTION,
            data: {
              targetURL: this.props.link.url,
              source: "newtab",
            },
          })
        );
      }
    } else {
      this.props.dispatch(
        ac.OnlyToMain({
          type: at.FILL_SEARCH_TERM,
          data: { label: this.props.link.label },
        })
      );
    }
  }

  onMenuUpdate(isOpen) {
    if (isOpen) {
      this.props.onActivate(this.props.index);
    } else {
      this.props.onActivate();
    }
  }

  render() {
    const { props } = this;
    const { link } = props;
    const isContextMenuOpen = props.activeIndex === props.index;
    const title = link.label || link.title || link.hostname;
    let menuOptions;
    if (link.sponsored_position) {
      menuOptions = TOP_SITES_SPONSORED_POSITION_CONTEXT_MENU_OPTIONS;
    } else if (link.searchTopSite) {
      menuOptions = TOP_SITES_SEARCH_SHORTCUTS_CONTEXT_MENU_OPTIONS;
    } else if (link.type === SPOC_TYPE) {
      menuOptions = TOP_SITES_SPOC_CONTEXT_MENU_OPTIONS;
    } else {
      menuOptions = TOP_SITES_CONTEXT_MENU_OPTIONS;
    }

    return (
      <TopSiteLink
        {...props}
        onClick={this.onLinkClick}
        onDragEvent={this.props.onDragEvent}
        className={`${props.className || ""}${
          isContextMenuOpen ? " active" : ""
        }`}
        title={title}
        setPref={this.props.setPref}
        tabIndex={this.props.tabIndex}
        onFocus={this.props.onFocus}
      >
        <div>
          <ContextMenuButton
            tooltip="newtab-menu-content-tooltip"
            tooltipArgs={{ title }}
            onUpdate={this.onMenuUpdate}
            tabIndex={this.props.tabIndex}
            onFocus={this.props.onFocus}
          >
            <LinkMenu
              dispatch={props.dispatch}
              index={props.index}
              onUpdate={this.onMenuUpdate}
              options={menuOptions}
              site={link}
              shouldSendImpressionStats={link.type === SPOC_TYPE}
              siteInfo={this._getTelemetryInfo()}
              source={TOP_SITES_SOURCE}
            />
          </ContextMenuButton>
        </div>
      </TopSiteLink>
    );
  }
}
TopSite.defaultProps = {
  link: {},
  onActivate() {},
};

export class TopSiteAddButton extends React.PureComponent {
  constructor(props) {
    super(props);
    this.onEditButtonClick = this.onEditButtonClick.bind(this);
  }

  onEditButtonClick() {
    this.props.dispatch({
      type: at.TOP_SITES_EDIT,
      data: { index: this.props.index },
    });
  }

  render() {
    return (
      <TopSiteLink
        {...this.props}
        isAddButton={true}
        className={`add-button ${this.props.className || ""}`}
        onClick={this.onEditButtonClick}
        setPref={this.props.setPref}
        isDraggable={false}
        tabIndex={this.props.tabIndex}
      />
    );
  }
}

export class TopSitePlaceholder extends React.PureComponent {
  render() {
    return (
      <TopSiteLink
        {...this.props}
        className={`placeholder ${this.props.className || ""}`}
        isDraggable={false}
      />
    );
  }
}

// The classic path renders this mode-agnostically. The grouped-pins path extends
// it through an explicit, opt-in prop contract (all inert when groupedPinsEnabled
// is false), kept here intentionally rather than composed via children/render-prop:
//   - groupedPinsEnabled: turns on the grouped-mode behavior below
//   - listProps / dropsOnList: zero-pin variant makes the whole <ul> one drop target
//   - decorations: zero-pin placeholder slot (zeroPinSlot/overZeroPin/setZeroPinRef)
//   - listRef: hands the <ul> back for the zero-pin drop geometry
//   - PinnedAreaOverlay (rendered inside the <ul>) self-measures .pinned-cell tiles
// Longer term these could be composed from the container (children/render-prop)
// so this list goes back to being fully mode-agnostic.
export class _TopSiteList extends React.PureComponent {
  static get DEFAULT_STATE() {
    return {
      activeIndex: null,
      focusedIndex: 0,
    };
  }

  constructor(props) {
    super(props);
    this.state = _TopSiteList.DEFAULT_STATE;
    this.onActivate = this.onActivate.bind(this);
    this.onWrapperFocus = this.onWrapperFocus.bind(this);
    this.onTopsiteFocus = this.onTopsiteFocus.bind(this);
    this.onWrapperBlur = this.onWrapperBlur.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
  }

  componentDidUpdate(prevProps) {
    // Drag state lives in the hook now; mirror the old reset of our own view
    // state (menu + focus) off the dragged-site signal.
    const started = !prevProps.draggedSite && this.props.draggedSite;
    const ended = prevProps.draggedSite && !this.props.draggedSite;
    if (started || ended) {
      // eslint-disable-next-line react/no-did-update-set-state
      this.setState(ended ? _TopSiteList.DEFAULT_STATE : { activeIndex: null });
    }
  }

  onActivate(index) {
    this.setState({ activeIndex: index });
  }

  onKeyDown(e) {
    if (this.state.activeIndex || this.state.activeIndex === 0) {
      return;
    }

    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // Arrow direction should match visual navigation direction in RTL
      const isRTL = document.dir === "rtl";
      const navigateToPrevious = isRTL
        ? e.key === "ArrowRight"
        : e.key === "ArrowLeft";

      const targetTopSite = navigateToPrevious
        ? this.focusedRef?.previousSibling
        : this.focusedRef?.nextSibling;

      const targetAnchor = targetTopSite?.querySelector("a");
      if (targetAnchor) {
        targetAnchor.tabIndex = 0;
        targetAnchor.focus();
      }
    }
  }

  onWrapperFocus() {
    this.focusRef?.addEventListener("keydown", this.onKeyDown);
  }
  onWrapperBlur() {
    this.focusRef?.removeEventListener("keydown", this.onKeyDown);
  }
  onTopsiteFocus(focusIndex) {
    this.setState(() => ({
      focusedIndex: focusIndex,
    }));
  }

  render() {
    const { props } = this;
    const topSites = this.props.sites;
    const topSitesUI = [];
    const commonProps = {
      onDragEvent: this.props.onDragEvent,
      dispatch: props.dispatch,
      groupedPinsEnabled: this.props.groupedPinsEnabled,
      // Zero-pin drops on the list (single target); everything else per-tile.
      dropsOnList: !!this.props.listProps,
    };
    const { decorations } = this.props;
    // We assign a key to each placeholder slot. We need it to be independent
    // of the slot index (i below) so that the keys used stay the same during
    // drag and drop reordering and the underlying DOM nodes are reused.
    // This mostly (only?) affects linux so be sure to test on linux before changing.
    let holeIndex = 0;

    // On narrow viewports, we only show 6 sites per row. We'll mark the rest as
    // .hide-for-narrow to hide in CSS via @media query.
    const novaEnabled = this.props.Prefs.values["nova.enabled"];
    const maxNarrowVisibleIndex = props.TopSitesRows * 6;
    const maxSmallVisibleIndex = props.TopSitesRows * 8;

    for (let i = 0, l = topSites.length; i < l; i++) {
      // Zero-pin grouped drag: with no pins there are no slots to reorder, so
      // open the pin area with one placeholder at the first pinnable slot.
      if (decorations && i === decorations.zeroPinSlot) {
        topSitesUI.push(
          <TopSitePlaceholder
            key="pinned-zero-drop"
            index={i}
            {...commonProps}
            className={`zero-pin-placeholder pinned-cell${
              decorations.overZeroPin ? " over" : ""
            }`}
            setRef={decorations.setZeroPinRef}
          />
        );
      }
      const link =
        topSites[i] &&
        Object.assign({}, topSites[i], {
          iconType: this.props.topSiteIconType(topSites[i]),
        });

      const slotProps = {
        key: link?.url || `hole-${holeIndex++}`,
        index: i,
      };
      // @nova-cleanup(remove-conditional): Remove classic path once Nova ships
      if (novaEnabled) {
        if (i >= maxSmallVisibleIndex) {
          slotProps.className = "nova-hide-for-s";
        } else if (i >= maxNarrowVisibleIndex) {
          slotProps.className = "nova-hide-for-xs";
        }
      } else if (i >= maxSmallVisibleIndex) {
        slotProps.className = "hide-for-small";
      } else if (i >= maxNarrowVisibleIndex) {
        slotProps.className = "hide-for-narrow";
      }
      // Marker (no styles) the drop-zone overlay measures to size the box. The
      // preview marks a joining frecent isPinned, so the box grows with it.
      if (this.props.groupedPinsEnabled && link?.isPinned) {
        slotProps.className = `${
          slotProps.className ? `${slotProps.className} ` : ""
        }pinned-cell`;
      }
      const { key: slotKey, ...restSlotProps } = slotProps;

      let topSiteLink = null;
      // Use a placeholder if the link is empty or it's rendering a sponsored
      // tile for the about:home startup cache.
      if (
        !link ||
        (props.App.isForStartupCache.TopSites && isSponsored(link))
      ) {
        if (link) {
          topSiteLink = (
            <TopSitePlaceholder
              key={slotKey}
              {...restSlotProps}
              {...commonProps}
            />
          );
        }
      } else if (topSites[i]?.isAddButton) {
        topSiteLink = (
          <TopSiteAddButton
            key={slotKey}
            {...restSlotProps}
            {...commonProps}
            setRef={
              i === this.state.focusedIndex
                ? el => {
                    this.focusedRef = el;
                  }
                : () => {}
            }
            tabIndex={i === this.state.focusedIndex ? 0 : -1}
            onFocus={() => {
              this.onTopsiteFocus(i);
            }}
            Messages={this.props.Messages}
            visibleTopSites={this.props.visibleTopSites}
          />
        );
      } else {
        topSiteLink = (
          <TopSite
            key={slotKey}
            link={link}
            activeIndex={this.state.activeIndex}
            onActivate={this.onActivate}
            {...restSlotProps}
            {...commonProps}
            colors={props.colors}
            setRef={
              i === this.state.focusedIndex
                ? el => {
                    this.focusedRef = el;
                  }
                : () => {}
            }
            tabIndex={i === this.state.focusedIndex ? 0 : -1}
            onFocus={() => {
              this.onTopsiteFocus(i);
            }}
            visibleTopSites={this.props.visibleTopSites}
          />
        );
      }

      // Skip empty slots — topSiteLink is null when there's no link and no placeholder.
      if (topSiteLink) {
        topSitesUI.push(topSiteLink);
      }
    }
    return (
      <div className="top-sites-list-wrapper">
        <ul
          role="group"
          aria-label="Shortcuts"
          onFocus={this.onWrapperFocus}
          onBlur={this.onWrapperBlur}
          {...this.props.listProps}
          ref={el => {
            this.focusRef = el;
            this.props.listRef?.(el);
          }}
          className={`top-sites-list${
            this.props.draggedSite ? " dnd-active" : ""
          }`}
          style={{
            "--top-sites-max-per-row":
              this.props.topSitesMaxSitesPerRow ?? TOP_SITES_MAX_SITES_PER_ROW,
          }}
        >
          {topSitesUI}
          {this.props.groupedPinsEnabled && (
            <PinnedAreaOverlay
              active={!!this.props.draggedSite}
              revision={topSites}
            />
          )}
        </ul>
      </div>
    );
  }
}

export const TopSiteList = connect(state => ({
  App: state.App,
  Messages: state.Messages,
  Prefs: state.Prefs,
}))(_TopSiteList);
