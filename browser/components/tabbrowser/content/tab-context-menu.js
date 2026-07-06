/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var TabContextMenu = {
  contextTab: null,
  _updateToggleMuteMenuItems(aTab, aConditionFn) {
    ["muted", "soundplaying"].forEach(attr => {
      if (!aConditionFn || aConditionFn(attr)) {
        if (aTab.hasAttribute(attr)) {
          aTab.toggleMuteMenuItem.setAttribute(attr, "true");
          aTab.toggleMultiSelectMuteMenuItem.setAttribute(attr, "true");
        } else {
          aTab.toggleMuteMenuItem.removeAttribute(attr);
          aTab.toggleMultiSelectMuteMenuItem.removeAttribute(attr);
        }
      }
    });
  },
  // eslint-disable-next-line complexity
  updateContextMenu(aPopupMenu) {
    let triggerTab =
      aPopupMenu.triggerNode &&
      (aPopupMenu.triggerNode.tab || aPopupMenu.triggerNode.closest("tab"));
    this.contextTab = triggerTab || gBrowser.selectedTab;
    this.contextTab.addEventListener("TabAttrModified", this);
    aPopupMenu.addEventListener("popuphidden", this);

    this.multiselected = this.contextTab.multiselected;
    this.contextTabs = this.multiselected
      ? gBrowser.selectedTabs
      : [this.contextTab];

    let splitViews = new Set();
    // bug1973996: This call is not guaranteed to complete
    // before the saved groups menu is populated
    for (let tab of this.contextTabs) {
      gBrowser.TabStateFlusher.flush(tab.linkedBrowser);

      // Add unique split views for count info below
      if (tab.splitview) {
        splitViews.add(tab.splitview);
      }
    }

    let disabled = gBrowser.tabs.length == 1;
    let tabCountInfo = JSON.stringify({
      tabCount: this.contextTabs.length,
    });
    let splitViewCountInfo = JSON.stringify({
      splitViewCount: splitViews.size,
    });

    var menuItems = aPopupMenu.getElementsByAttribute(
      "tbattr",
      "tabbrowser-multiple"
    );
    for (let menuItem of menuItems) {
      menuItem.disabled = disabled;
    }

    disabled = gBrowser.visibleTabs.length == 1;
    menuItems = aPopupMenu.getElementsByAttribute(
      "tbattr",
      "tabbrowser-multiple-visible"
    );
    for (let menuItem of menuItems) {
      menuItem.disabled = disabled;
    }

    let contextNewTabButton = document.getElementById("context_openANewTab");
    // update context menu item strings for vertical tabs
    document.l10n.setAttributes(
      contextNewTabButton,
      gBrowser.tabContainer?.verticalMode
        ? "tab-context-new-tab-open-vertical"
        : "tab-context-new-tab-open"
    );

    // Session store
    let closedCount = SessionStore.getLastClosedTabCount(window);
    document
      .getElementById("History:UndoCloseTab")
      .toggleAttribute("disabled", closedCount == 0);
    document.l10n.setArgs(document.getElementById("context_undoCloseTab"), {
      tabCount: closedCount,
    });

    // Show/hide fullscreen context menu items and set the
    // autohide item's checked state to mirror the autohide pref.
    showFullScreenViewContextMenuItems(aPopupMenu);

    // #context_moveTabToNewGroup is a simplified context menu item that only
    // appears if there are no existing tab groups available to move the tab to.
    let contextMoveTabToNewGroup = document.getElementById(
      "context_moveTabToNewGroup"
    );
    let contextMoveTabToGroup = document.getElementById(
      "context_moveTabToGroup"
    );
    let contextUngroupTab = document.getElementById("context_ungroupTab");
    let contextMoveSplitViewToNewGroup = document.getElementById(
      "context_moveSplitViewToNewGroup"
    );
    let contextUngroupSplitView = document.getElementById(
      "context_ungroupSplitView"
    );
    let isAllSplitViewTabs = this.contextTabs.every(
      contextTab => contextTab.splitview
    );

    if (gBrowser._tabGroupsEnabled) {
      let selectedGroupCount = new Set(
        // The filter removes the "null" group for ungrouped tabs.
        this.contextTabs.map(t => t.group).filter(g => g)
      ).size;

      let openGroupsToMoveTo = gBrowser.getAllTabGroups({
        sortByLastSeenActive: true,
      });

      // Determine whether or not the "current" tab group should appear in the
      // "move tab to group" context menu.
      if (selectedGroupCount == 1) {
        let groupToFilter = this.contextTabs[0].group;
        if (groupToFilter && this.contextTabs.every(t => t.group)) {
          openGroupsToMoveTo = openGroupsToMoveTo.filter(
            group => group !== groupToFilter
          );
        }
      }

      // Populate the saved groups context menu
      // Only enable in non-private windows, or if at least one of the tabs is
      // considered saveable
      let savedGroupsToMoveTo = [];
      if (
        !PrivateBrowsingUtils.isWindowPrivate(window) &&
        SessionStore.shouldSaveTabsToGroup(this.contextTabs)
      ) {
        savedGroupsToMoveTo = SessionStore.getSavedTabGroups();
      }

      if (!openGroupsToMoveTo.length && !savedGroupsToMoveTo.length) {
        if (isAllSplitViewTabs) {
          contextMoveTabToGroup.hidden = true;
          contextMoveTabToNewGroup.hidden = true;
          contextMoveSplitViewToNewGroup.hidden = false;
          contextMoveSplitViewToNewGroup.setAttribute(
            "data-l10n-args",
            splitViewCountInfo
          );
        } else {
          contextMoveTabToGroup.hidden = true;
          contextMoveSplitViewToNewGroup.hidden = true;
          contextMoveTabToNewGroup.hidden = false;
          contextMoveTabToNewGroup.setAttribute("data-l10n-args", tabCountInfo);
        }
      } else {
        if (isAllSplitViewTabs) {
          contextMoveTabToNewGroup.hidden = true;
          contextMoveSplitViewToNewGroup.hidden = true;
          contextMoveTabToGroup.hidden = false;
          contextMoveTabToGroup.setAttribute(
            "data-l10n-id",
            "tab-context-move-split-view-to-group"
          );
          contextMoveTabToGroup.setAttribute(
            "data-l10n-args",
            splitViewCountInfo
          );
        } else {
          contextMoveTabToNewGroup.hidden = true;
          contextMoveSplitViewToNewGroup.hidden = true;
          contextMoveTabToGroup.hidden = false;
          contextMoveTabToGroup.setAttribute(
            "data-l10n-id",
            "tab-context-move-tab-to-group"
          );
          contextMoveTabToGroup.setAttribute("data-l10n-args", tabCountInfo);
        }

        const openGroupsMenu = contextMoveTabToGroup.querySelector("menupopup");
        openGroupsMenu
          .querySelectorAll("[tab-group-id]")
          .forEach(el => el.remove());
        const upperSeparator = openGroupsMenu.querySelector(
          `#open-tab-groups-separator-upper`
        );
        const lowerSeparator = openGroupsMenu.querySelector(
          `#open-tab-groups-separator-lower`
        );

        lowerSeparator.hidden = !openGroupsToMoveTo.length;

        openGroupsToMoveTo.toReversed().forEach(group => {
          let item = this._createTabGroupMenuItem(group, false);
          upperSeparator.after(item);
        });

        const savedGroupsMenu = contextMoveTabToGroup.querySelector(
          "#context_moveTabToSavedGroup"
        );
        const savedGroupsMenuPopup = savedGroupsMenu.querySelector("menupopup");

        savedGroupsMenuPopup
          .querySelectorAll("[tab-group-id]")
          .forEach(el => el.remove());
        if (savedGroupsToMoveTo.length) {
          savedGroupsMenu.disabled = false;

          savedGroupsToMoveTo.forEach(group => {
            let item = this._createTabGroupMenuItem(group, true);
            savedGroupsMenuPopup.appendChild(item);
          });
        } else {
          savedGroupsMenu.disabled = true;
        }
      }

      let groupInfo = JSON.stringify({
        groupCount: selectedGroupCount,
      });
      if (isAllSplitViewTabs) {
        contextUngroupSplitView.hidden = !selectedGroupCount;
        contextUngroupTab.hidden = true;
        contextUngroupSplitView.setAttribute("data-l10n-args", groupInfo);
      } else {
        contextUngroupTab.hidden = !selectedGroupCount;
        contextUngroupSplitView.hidden = true;
        contextUngroupTab.setAttribute("data-l10n-args", groupInfo);
      }
    } else {
      contextMoveTabToNewGroup.hidden = true;
      contextMoveTabToGroup.hidden = true;
      contextUngroupTab.hidden = true;
      contextMoveSplitViewToNewGroup.hidden = true;
      contextUngroupSplitView.hidden = true;
    }

    let contextAddNote = document.getElementById("context_addNote");
    let contextEditNote = document.getElementById("context_editNote");
    if (gBrowser._tabNotesEnabled) {
      // Tab notes behaviour is disabled if a user has a selection of tabs that
      // contains more than one canonical URL.
      let multiselectingDiverseUrls =
        this.multiselected &&
        !this.contextTabs.every(
          t => t.canonicalUrl === this.contextTabs[0].canonicalUrl
        );

      contextAddNote.disabled =
        multiselectingDiverseUrls || !this.TabNotes.isEligible(this.contextTab);
      contextEditNote.disabled = multiselectingDiverseUrls;

      this.removeNewBadge(contextAddNote);
      if (
        Services.prefs.getBoolPref("browser.tabs.notes.newBadge.enabled", true)
      ) {
        this.addNewBadge(contextAddNote);
      }

      this.TabNotes.has(this.contextTab).then(hasNote => {
        contextAddNote.hidden = hasNote;
        contextEditNote.hidden = !hasNote;
      });
    } else {
      contextAddNote.hidden = true;
      contextEditNote.hidden = true;
    }

    // Split View
    let splitViewEnabled = Services.prefs.getBoolPref(
      "browser.tabs.splitView.enabled",
      false
    );
    let contextMoveTabToNewSplitView = document.getElementById(
      "context_moveTabToSplitView"
    );
    let contextSeparateSplitView = document.getElementById(
      "context_separateSplitView"
    );
    let contextReverseSplitView = document.getElementById(
      "context_reverseSplitView"
    );
    let hasSplitViewTab = this.contextTabs.some(tab => tab.splitview);
    contextMoveTabToNewSplitView.hidden = !splitViewEnabled || hasSplitViewTab;
    contextSeparateSplitView.hidden = !splitViewEnabled || !hasSplitViewTab;
    contextReverseSplitView.hidden =
      !splitViewEnabled || !hasSplitViewTab || this.multiselected;
    if (splitViewEnabled) {
      contextMoveTabToNewSplitView.removeAttribute("data-l10n-id");
      contextMoveTabToNewSplitView.setAttribute(
        "data-l10n-id",
        this.contextTabs.length < 2
          ? "tab-context-add-split-view"
          : "tab-context-open-in-split-view"
      );

      let pinnedTabs = this.contextTabs.filter(t => t.pinned);
      let customizeTabs = this.contextTabs.filter(t =>
        t.hasAttribute("customizemode")
      );
      contextMoveTabToNewSplitView.disabled =
        this.contextTabs.length > 2 ||
        pinnedTabs.length ||
        customizeTabs.length;
    }

    // Only one of Reload_Tab/Reload_Selected_Tabs should be visible.
    document.getElementById("context_reloadTab").hidden = this.multiselected;
    document.getElementById("context_reloadSelectedTabs").hidden =
      !this.multiselected;
    let unloadTabItem = document.getElementById("context_unloadTab");
    if (gBrowser._unloadTabInContextMenu) {
      // linkedPanel is false if the tab is already unloaded
      // Cannot unload about: pages, etc., so skip browsers that are not remote
      let unloadableTabs = this.contextTabs.filter(
        t => t.linkedPanel && t.linkedBrowser?.isRemoteBrowser
      );
      unloadTabItem.hidden = unloadableTabs.length === 0;
      unloadTabItem.setAttribute(
        "data-l10n-args",
        JSON.stringify({ tabCount: unloadableTabs.length })
      );
    } else {
      unloadTabItem.hidden = true;
    }

    // Show Play Tab menu item if the tab has attribute activemedia-blocked
    document.getElementById("context_playTab").hidden = !(
      this.contextTab.activeMediaBlocked && !this.multiselected
    );
    document.getElementById("context_playSelectedTabs").hidden = !(
      this.contextTab.activeMediaBlocked && this.multiselected
    );

    // Only one of pin/unpin/multiselect-pin/multiselect-unpin should be visible
    let hasAboutOpenTabsTab = this.contextTabs.some(
      t => t.linkedBrowser.currentURI.spec === "about:opentabs"
    );
    let contextPinTab = document.getElementById("context_pinTab");
    contextPinTab.hidden =
      this.contextTab.pinned || this.multiselected || hasAboutOpenTabsTab;
    let contextUnpinTab = document.getElementById("context_unpinTab");
    contextUnpinTab.hidden = !this.contextTab.pinned || this.multiselected;
    let contextPinSelectedTabs = document.getElementById(
      "context_pinSelectedTabs"
    );
    contextPinSelectedTabs.hidden =
      this.contextTab.pinned || !this.multiselected || hasAboutOpenTabsTab;
    let contextUnpinSelectedTabs = document.getElementById(
      "context_unpinSelectedTabs"
    );
    contextUnpinSelectedTabs.hidden =
      !this.contextTab.pinned || !this.multiselected;

    // Build Ask Chat items
    TabContextMenu.GenAI.buildTabMenu(
      document.getElementById("context_askChat"),
      this
    );

    // Move Tab items
    let contextMoveTabOptions = document.getElementById(
      "context_moveTabOptions"
    );
    // gBrowser.visibleTabs excludes tabs in collapsed groups,
    // which we want to include in calculations for Move Tab items
    let visibleOrCollapsedTabs = gBrowser.tabs.filter(
      t => t.isOpen && !t.hidden
    );
    let allTabsSelected =
      visibleOrCollapsedTabs.length == 1 ||
      visibleOrCollapsedTabs.every(t => t.multiselected);
    contextMoveTabOptions.setAttribute("data-l10n-args", tabCountInfo);
    contextMoveTabOptions.disabled = this.contextTab.hidden || allTabsSelected;
    let selectedTabs = gBrowser.selectedTabs;
    let contextMoveTabToEnd = document.getElementById("context_moveToEnd");
    let allSelectedTabsAdjacent = selectedTabs.every(
      (element, index, array) => {
        return array.length > index + 1
          ? element._tPos + 1 == array[index + 1]._tPos
          : true;
      }
    );

    let lastVisibleTab = visibleOrCollapsedTabs.at(-1);
    let lastTabToMove = this.contextTabs.at(-1);

    let isLastPinnedTab = false;
    if (lastTabToMove.pinned) {
      let sibling = gBrowser.tabContainer.findNextTab(lastTabToMove);
      isLastPinnedTab = !sibling || !sibling.pinned;
    }

    let isSplit = !!this.contextTab.splitview;
    let firstInSplit = isSplit ? this.contextTab.splitview.tabs[0] : null;
    let lastInSplit = isSplit ? this.contextTab.splitview.tabs.at(-1) : null;
    let splitAtEnd = isSplit && lastInSplit === lastVisibleTab;
    contextMoveTabToEnd.disabled =
      (lastTabToMove === lastVisibleTab || isLastPinnedTab || splitAtEnd) &&
      !lastTabToMove.group &&
      allSelectedTabsAdjacent;

    let contextMoveTabToStart = document.getElementById("context_moveToStart");
    let isFirstTab =
      !this.contextTabs[0].group &&
      (this.contextTabs[0] === visibleOrCollapsedTabs[0] ||
        this.contextTabs[0] ===
          visibleOrCollapsedTabs[gBrowser.pinnedTabCount]);
    let splitAtStart =
      isSplit &&
      (firstInSplit === visibleOrCollapsedTabs[0] ||
        firstInSplit === visibleOrCollapsedTabs[gBrowser.pinnedTabCount]);
    contextMoveTabToStart.disabled =
      (isFirstTab || splitAtStart) && allSelectedTabsAdjacent;

    document.getElementById("context_openTabInWindow").disabled =
      this.contextTab.hasAttribute("customizemode");

    // Only one of "Duplicate Tab"/"Duplicate Tabs" should be visible.
    document.getElementById("context_duplicateTab").hidden = this.multiselected;
    document.getElementById("context_duplicateTabs").hidden =
      !this.multiselected;

    let closeTabsToTheStartItem = document.getElementById(
      "context_closeTabsToTheStart"
    );

    // update context menu item strings for vertical tabs
    document.l10n.setAttributes(
      closeTabsToTheStartItem,
      gBrowser.tabContainer?.verticalMode
        ? "close-tabs-to-the-start-vertical"
        : "close-tabs-to-the-start"
    );

    let closeTabsToTheEndItem = document.getElementById(
      "context_closeTabsToTheEnd"
    );

    // update context menu item strings for vertical tabs
    document.l10n.setAttributes(
      closeTabsToTheEndItem,
      gBrowser.tabContainer?.verticalMode
        ? "close-tabs-to-the-end-vertical"
        : "close-tabs-to-the-end"
    );

    // Disable "Close Tabs to the Left/Right" if there are no tabs
    // preceding/following it.
    let noTabsToStart = !gBrowser._getTabsToTheStartFrom(this.contextTab)
      .length;
    closeTabsToTheStartItem.disabled = noTabsToStart;

    let noTabsToEnd = !gBrowser._getTabsToTheEndFrom(this.contextTab).length;
    closeTabsToTheEndItem.disabled = noTabsToEnd;

    // Disable "Close other Tabs" if there are no unpinned tabs.
    let unpinnedTabsToClose = this.multiselected
      ? gBrowser.openTabs.filter(
          t => !t.multiselected && !t.pinned && !t.hidden
        ).length
      : gBrowser.openTabs.filter(
          t => t != this.contextTab && !t.pinned && !t.hidden
        ).length;
    let closeOtherTabsItem = document.getElementById("context_closeOtherTabs");
    closeOtherTabsItem.disabled = unpinnedTabsToClose < 1;

    // Update the close item with how many tabs will close.
    document
      .getElementById("context_closeTab")
      .setAttribute("data-l10n-args", tabCountInfo);

    let closeDuplicateTabsItem = document.getElementById(
      "context_closeDuplicateTabs"
    );
    closeDuplicateTabsItem.disabled = !gBrowser.getDuplicateTabsToClose(
      this.contextTab
    ).length;

    // Disable "Close Multiple Tabs" if all sub menuitems are disabled
    document.getElementById("context_closeTabOptions").disabled =
      closeTabsToTheStartItem.disabled &&
      closeTabsToTheEndItem.disabled &&
      closeOtherTabsItem.disabled;

    // Hide "Bookmark Tab…" for multiselection.
    // Update its state if visible.
    let bookmarkTab = document.getElementById("context_bookmarkTab");
    bookmarkTab.hidden = this.multiselected;

    // Show "Bookmark Selected Tabs" in a multiselect context and hide it otherwise.
    let bookmarkMultiSelectedTabs = document.getElementById(
      "context_bookmarkSelectedTabs"
    );
    bookmarkMultiSelectedTabs.hidden = !this.multiselected;

    let contentSharingShareTabs = document.getElementById(
      "context_shareSelectedTabs"
    );

    const hideContentSharing =
      !this.multiselected || !ContentSharingUtils.isEnabled;
    contentSharingShareTabs.hidden = hideContentSharing;
    document.getElementById("context_shareSelectedTabsSeparator").hidden =
      hideContentSharing;
    if (!contentSharingShareTabs.hidden) {
      this.addNewBadge(contentSharingShareTabs);
    }

    let toggleMute = document.getElementById("context_toggleMuteTab");
    let toggleMultiSelectMute = document.getElementById(
      "context_toggleMuteSelectedTabs"
    );

    // Only one of mute_unmute_tab/mute_unmute_selected_tabs should be visible
    toggleMute.hidden = this.multiselected;
    toggleMultiSelectMute.hidden = !this.multiselected;

    const isMuted = this.contextTab.hasAttribute("muted");
    document.l10n.setAttributes(
      toggleMute,
      isMuted ? "tabbrowser-context-unmute-tab" : "tabbrowser-context-mute-tab"
    );
    document.l10n.setAttributes(
      toggleMultiSelectMute,
      isMuted
        ? "tabbrowser-context-unmute-selected-tabs"
        : "tabbrowser-context-mute-selected-tabs"
    );

    this.contextTab.toggleMuteMenuItem = toggleMute;
    this.contextTab.toggleMultiSelectMuteMenuItem = toggleMultiSelectMute;
    this._updateToggleMuteMenuItems(this.contextTab);

    let selectAllTabs = document.getElementById("context_selectAllTabs");
    selectAllTabs.disabled = gBrowser.allTabsSelected();

    gSync.updateTabContextMenu(aPopupMenu, this.contextTab);

    let reopenInContainer = document.getElementById(
      "context_reopenInContainer"
    );
    reopenInContainer.hidden =
      !Services.prefs.getBoolPref("privacy.userContext.enabled", false) ||
      PrivateBrowsingUtils.isWindowPrivate(window);
    reopenInContainer.disabled = this.contextTab.hidden;

    SharingUtils.ensureShareMenu(
      this.contextTab.linkedBrowser,
      this.multiselected ? this.contextTabs.map(t => t.linkedBrowser) : null,
      document.getElementById("context_moveTabOptions")
    );
  },

  _createTabGroupMenuItem(group, isSaved) {
    let item = document.createXULElement("menuitem");
    item.setAttribute("tab-group-id", group.id);

    // Open groups have labels, and saved groups have names
    let label = group.label ?? group.name;
    if (label) {
      item.setAttribute("label", label);
    } else {
      document.l10n.setAttributes(item, "tab-context-unnamed-group");
    }

    item.classList.add("menuitem-iconic", "tab-group-icon");
    if (isSaved) {
      item.classList.add("tab-group-icon-closed");
    }

    item.style.setProperty(
      "--tab-group-color",
      `var(--tab-group-color-${group.color})`
    );
    item.style.setProperty(
      "--tab-group-color-invert",
      `var(--tab-group-color-${group.color}-invert)`
    );
    item.style.setProperty(
      "--tab-group-color-pale",
      `var(--tab-group-color-${group.color}-pale)`
    );
    item.style.setProperty(
      "--tab-group-background-color",
      `var(--tab-group-${group.color})`
    );

    return item;
  },

  handleEvent(aEvent) {
    switch (aEvent.type) {
      case "popuphidden":
        if (aEvent.target.id == "tabContextMenu") {
          this.contextTab.removeEventListener("TabAttrModified", this);
          this.contextTab = null;
          this.contextTabs = null;
        }
        break;
      case "TabAttrModified": {
        let tab = aEvent.target;
        this._updateToggleMuteMenuItems(tab, attr =>
          aEvent.detail.changed.includes(attr)
        );
        break;
      }
    }
  },

  createReopenInContainerMenu(event) {
    createUserContextMenu(event, {
      isContextMenu: true,
      excludeUserContextId: this.contextTab.getAttribute("usercontextid"),
    });
  },
  duplicateSelectedTabs() {
    let newIndex = this.contextTabs.at(-1)._tPos + 1;
    for (let tab of this.contextTabs) {
      let newTab = SessionStore.duplicateTab(window, tab);
      if (tab.group) {
        Glean.tabgroup.tabInteractions.duplicate.add();
      }
      gBrowser.moveTabTo(newTab, { tabIndex: newIndex++ });
    }
  },
  reopenInContainer(event) {
    let userContextId = parseInt(
      event.target.getAttribute("data-usercontextid")
    );

    for (let tab of this.contextTabs) {
      if (tab.getAttribute("usercontextid") == userContextId) {
        continue;
      }

      /* Create a triggering principal that is able to load the new tab
         For content principals that are about: chrome: or resource: we need system to load them.
         Anything other than system principal needs to have the new userContextId.
      */
      let triggeringPrincipal;

      if (tab.linkedPanel) {
        triggeringPrincipal = tab.linkedBrowser.contentPrincipal;
      } else {
        // For lazy tab browsers, get the original principal
        // from SessionStore
        let tabState = JSON.parse(SessionStore.getTabState(tab));
        try {
          triggeringPrincipal = E10SUtils.deserializePrincipal(
            tabState.triggeringPrincipal_base64
          );
        } catch (ex) {
          continue;
        }
      }

      if (!triggeringPrincipal || triggeringPrincipal.isNullPrincipal) {
        // Ensure that we have a null principal if we couldn't
        // deserialize it (for lazy tab browsers) ...
        // This won't always work however is safe to use.
        triggeringPrincipal =
          Services.scriptSecurityManager.createNullPrincipal({ userContextId });
      } else if (triggeringPrincipal.isContentPrincipal) {
        triggeringPrincipal = Services.scriptSecurityManager.principalWithOA(
          triggeringPrincipal,
          {
            userContextId,
          }
        );
      }

      let newTab = gBrowser.addTab(tab.linkedBrowser.currentURI.spec, {
        userContextId,
        pinned: tab.pinned,
        tabIndex: tab._tPos + 1,
        triggeringPrincipal,
      });

      Glean.containers.tabAssignedContainer.record({
        from_container_id: tab.getAttribute("usercontextid"),
        to_container_id: userContextId,
      });

      if (gBrowser.selectedTab == tab) {
        gBrowser.selectedTab = newTab;
      }
      if (tab.muted && !newTab.muted) {
        newTab.toggleMuteAudio(tab.muteReason);
      }
    }
  },

  closeContextTabs() {
    if (this.contextTab.multiselected) {
      gBrowser.removeMultiSelectedTabs({
        metricsContext: gBrowser.TabMetrics.userTriggeredContext(
          gBrowser.TabMetrics.METRIC_SOURCE.TAB_MENU
        ),
      });
    } else {
      gBrowser.removeTab(this.contextTab, {
        animate: true,
        metricsContext: gBrowser.TabMetrics.userTriggeredContext(
          gBrowser.TabMetrics.METRIC_SOURCE.TAB_MENU
        ),
      });
    }
  },

  explicitUnloadTabs() {
    gBrowser.explicitUnloadTabs(this.contextTabs);
  },

  moveTabsToNewGroup() {
    let insertBefore = this.contextTab;
    if (insertBefore._tPos < gBrowser.pinnedTabCount) {
      let firstUnpinnedTab = gBrowser.tabs[gBrowser.pinnedTabCount];
      if (firstUnpinnedTab.splitview) {
        insertBefore = firstUnpinnedTab.splitview;
      } else {
        insertBefore = firstUnpinnedTab;
      }
    } else if (this.contextTab.group) {
      insertBefore = this.contextTab.group;
    } else if (this.contextTab.splitview) {
      insertBefore = this.contextTab.splitview;
    }
    gBrowser.addTabGroup(this.contextTabs, {
      insertBefore,
      metricsContext: gBrowser.TabMetrics.userTriggeredContext(
        gBrowser.TabMetrics.METRIC_SOURCE.TAB_MENU
      ),
    });
    gBrowser.selectedTab = this.contextTabs[0];

    // When using the tab context menu to create a group from the all tabs
    // panel, make sure we close that panel so that it doesn't obscure the tab
    // group creation panel.
    gTabsPanel.hideAllTabsPanel();
  },

  moveSplitViewToNewGroup() {
    let insertBefore = this.contextTab;
    if (insertBefore._tPos < gBrowser.pinnedTabCount) {
      insertBefore = gBrowser.tabs[gBrowser.pinnedTabCount];
    } else if (this.contextTab.group) {
      insertBefore = this.contextTab.group;
    } else if (this.contextTab.splitview) {
      insertBefore = this.contextTab.splitview;
    }
    let tabsAndSplitViews = [];
    for (const contextTab of this.contextTabs) {
      if (contextTab.splitView) {
        if (!tabsAndSplitViews.includes(contextTab.splitView)) {
          tabsAndSplitViews.push(contextTab.splitView);
        }
      } else {
        tabsAndSplitViews.push(contextTab);
      }
    }
    gBrowser.addTabGroup(tabsAndSplitViews, {
      insertBefore,
      metricsContext: gBrowser.TabMetrics.userTriggeredContext(
        gBrowser.TabMetrics.METRIC_SOURCE.TAB_MENU
      ),
    });
    gBrowser.selectedTab = this.contextTabs[0];

    // When using the tab context menu to create a group from the all tabs
    // panel, make sure we close that panel so that it doesn't obscure the tab
    // group creation panel.
    gTabsPanel.hideAllTabsPanel();
  },

  /**
   * @param {MozTabbrowserTabGroup} group
   */
  moveTabsToGroup(group) {
    let elementsToMove = new Set();
    for (let tab of this.contextTabs) {
      elementsToMove.add(tab.splitview ?? tab);
    }
    group.addTabs(
      Array.from(elementsToMove.values()),
      gBrowser.TabMetrics.userTriggeredContext(
        gBrowser.TabMetrics.METRIC_SOURCE.TAB_MENU
      )
    );
    group.documentGlobal.focus();
  },

  addTabsToSavedGroup(groupId) {
    let seen = new Set();
    let tabs = [];
    for (let tab of this.contextTabs) {
      if (tab.splitview) {
        for (let splitTab of tab.splitview.tabs) {
          if (!seen.has(splitTab)) {
            seen.add(splitTab);
            tabs.push(splitTab);
          }
        }
      } else if (!seen.has(tab)) {
        seen.add(tab);
        tabs.push(tab);
      }
    }
    SessionStore.addTabsToSavedGroup(
      groupId,
      tabs,
      gBrowser.TabMetrics.userTriggeredContext(
        gBrowser.TabMetrics.METRIC_SOURCE.TAB_MENU
      )
    );
    gBrowser.removeTabs(tabs, {
      animate: true,
      metricsContext: gBrowser.TabMetrics.userTriggeredContext(
        gBrowser.TabMetrics.METRIC_SOURCE.TAB_MENU
      ),
    });
  },

  ungroupTabsAndSplitViews() {
    let splitViews = new Set();
    for (const tab of this.contextTabs) {
      if (tab.splitview && !splitViews.has(tab.splitview)) {
        splitViews.add(tab.splitview);
        gBrowser.ungroupSplitView(tab.splitview);
      } else if (!tab.splitview) {
        gBrowser.ungroupTab(tab);
      }
    }
  },

  moveTabsToSplitView() {
    let insertBefore = this.contextTabs.includes(gBrowser.selectedTab)
      ? gBrowser.selectedTab
      : this.contextTabs[0];
    let tabsToAdd = this.contextTabs;

    // Ensure selected tab is always first in split view
    const selectedTabIndex = tabsToAdd.indexOf(gBrowser.selectedTab);
    if (selectedTabIndex > -1 && selectedTabIndex != 0) {
      const [removed] = tabsToAdd.splice(selectedTabIndex, 1);
      tabsToAdd.unshift(removed);
    }

    let newTab = null;
    let trigger;
    if (this.contextTabs.length < 2) {
      // Open new tab to split with context tab
      newTab = gBrowser.addTrustedTab("about:opentabs");
      tabsToAdd = [this.contextTabs[0], newTab];
      trigger = "menu_add";
    } else {
      trigger = "menu_open";
    }

    gBrowser.addTabSplitView(tabsToAdd, {
      insertBefore,
      trigger,
    });

    if (newTab) {
      gBrowser.selectedTab = newTab;
    }
  },

  unsplitTabs() {
    const splitviews = new Set(
      this.contextTabs.map(tab => tab.splitview).filter(Boolean)
    );
    splitviews.forEach(splitview => splitview.unsplitTabs("menu_separate"));
  },

  reverseSplitView() {
    this.contextTab.splitview?.reverseTabs("menu");
  },

  /**
   * @param {MozMenuItem} menuItem
   */
  addNewBadge(menuItem) {
    menuItem.setAttribute(
      "badge",
      gBrowser.tabLocalization.formatValueSync("tab-context-badge-new")
    );
    menuItem.classList.add("badge-new");
  },

  /**
   * @param {MozMenuItem} menuItem
   */
  removeNewBadge(menuItem) {
    menuItem.removeAttribute("badge");
    menuItem.classList.remove("badge-new");
  },
};

ChromeUtils.defineESModuleGetters(TabContextMenu, {
  GenAI: "resource:///modules/GenAI.sys.mjs",
  TabNotes: "moz-src:///browser/components/tabnotes/TabNotes.sys.mjs",
});
