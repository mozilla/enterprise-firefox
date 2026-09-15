/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  MONITOR_AGENTS_CHANGED_TOPIC:
    "moz-src:///browser/components/aiwindow/models/agents/Monitor.sys.mjs",
  MonitorAgent:
    "moz-src:///browser/components/aiwindow/models/agents/MonitorAgent.sys.mjs",
  TOTAL_NUM_MONITORS:
    "moz-src:///browser/components/aiwindow/models/agents/Monitor.sys.mjs",
  MonitorUIUtils:
    "moz-src:///browser/components/aiwindow/ui/modules/MonitorUIUtils.sys.mjs",
  isAllowedWatchUrl:
    "moz-src:///browser/components/aiwindow/models/agents/Monitor.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "gBundle", function () {
  return Services.strings.createBundle(
    "chrome://browser/locale/browser.properties"
  );
});

const BUTTON_ID = "smartwindow-monitor-button";
const PANEL_ID = "smartwindow-monitor-panel";
const TITLE_ID = "smartwindow-monitor-panel-title";
const TASKS_PAGE_URL = "about:smartwindowtasks";

// The header names whichever view is showing.
const VIEW_TITLE_L10N_IDS = {
  list: "smartwindow-monitor-panel-title",
  create: "smartwindow-monitor-panel-create-title",
};

/**
 * The Smart Window "Tasks" panel, anchored to its toolbar button. The panel is
 * created on demand and removed when it closes.
 *
 * Monitors live in MonitorAgent and change from its own timers as well as from
 * other surfaces, so this module owns the data: it pushes monitors into the
 * agent-monitor-panel element and refreshes them while the panel is open. The
 * element only renders and reports what the user did.
 */
export const MonitorPanel = {
  /**
   * @param {ChromeWindow} win
   */
  toggleMonitorPanel(win) {
    const doc = win?.document;
    if (!doc) {
      return;
    }

    const existing = doc.getElementById(PANEL_ID);
    if (existing) {
      existing.hidePopup();
      return;
    }

    this.showMonitorPanel(win);
  },

  /**
   * @param {ChromeWindow} win
   */
  showMonitorPanel(win) {
    const doc = win.document;
    const button = doc.getElementById(BUTTON_ID);
    const popupSet = doc.getElementById("mainPopupSet");
    if (!button || !popupSet) {
      return;
    }

    // Opening the panel answers the attention dot. Taking the ids and
    // it only clears once the panel has committed to opening.
    const attentionIds = lazy.AIWindow.takeMonitorAttentionIds();

    // Anchor to the overflow button rather than the button itself when the
    // widget has been moved into the overflow panel.
    const anchor =
      lazy.CustomizableUI.getWidget(BUTTON_ID)?.forWindow(win)?.anchor ??
      button;

    const panel = this._createPanel(win);
    panel._contents.attentionIds = attentionIds;
    const onMonitorsChanged = () => this._syncContents(panel);

    panel.addEventListener(
      "popupshown",
      () => {
        button.setAttribute("aria-expanded", "true");
        Services.obs.addObserver(
          onMonitorsChanged,
          lazy.MONITOR_AGENTS_CHANGED_TOPIC
        );
      },
      { once: true }
    );
    panel.addEventListener(
      "popuphidden",
      () => {
        button.setAttribute("aria-expanded", "false");
        Services.obs.removeObserver(
          onMonitorsChanged,
          lazy.MONITOR_AGENTS_CHANGED_TOPIC
        );
        panel.remove();
      },
      { once: true }
    );

    popupSet.appendChild(panel);
    panel.openPopup(anchor, "bottomright topright", 0, 4, false, false);
    this._syncContents(panel);
  },

  /**
   * @param {ChromeWindow} win
   * @returns {XULElement} A detached panel with its header and contents.
   */
  _createPanel(win) {
    const doc = win.document;

    const panel = doc.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("orient", "vertical");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", TITLE_ID);

    const header = doc.createXULElement("box");
    header.className = "panel-header";
    const heading = doc.createElement("h1");
    heading.id = TITLE_ID;
    const title = doc.createElement("span");
    heading.appendChild(title);
    header.appendChild(heading);
    panel._header = header;
    panel._title = title;

    const contents = doc.createElement("agent-monitor-panel");
    contents.maxMonitors = lazy.TOTAL_NUM_MONITORS;
    contents.addEventListener("agent-monitor-panel:create-task", () => {
      // Set the agent's URL to the current watchable page.
      contents.agent = { url: this._watchableUrl(win) };
      this._setView(panel, "create");
    });
    contents.addEventListener("agent-monitor-item:cancel", () =>
      this._setView(panel, "list")
    );
    contents.addEventListener("agent-monitor-item:submit", event =>
      this._onCreateSubmit(panel, event.detail)
    );
    // The form is torn down whenever the panel closes or the view changes, so
    // the draft is held out here to survive that.
    contents.addEventListener("agent-monitor-item:draft-change", event => {
      contents.draft = event.detail.draft;
    });
    contents.addEventListener("agent-monitor-panel:manage-tasks", () => {
      win.switchToTabHavingURI(TASKS_PAGE_URL, true);
      panel.hidePopup();
    });
    contents.addEventListener("agent-monitor-panel:open-task", () => {
      win.switchToTabHavingURI(TASKS_PAGE_URL, true);
      panel.hidePopup();
    });
    panel._contents = contents;

    panel.append(header, doc.createXULElement("toolbarseparator"), contents);
    this._setView(panel, "list");
    return panel;
  },

  /**
   * @param {ChromeWindow} win
   * @returns {string} The URL of the page the user is on, or "" when it isn't a
   *   page a monitor can watch (about: pages, view-source, and so on).
   */
  _watchableUrl(win) {
    const url = win.gBrowser?.currentURI?.spec ?? "";
    return lazy.isAllowedWatchUrl(url) ? url : "";
  },

  /**
   * The header names the view and offers the way back out of it, so it and the
   * contents are switched together from here rather than tracking the view in
   * two places.
   *
   * @param {XULElement} panel
   * @param {"list"|"create"} view
   */
  _setView(panel, view) {
    const doc = panel.ownerDocument;
    panel._contents.view = view;
    doc.l10n.setAttributes(panel._title, VIEW_TITLE_L10N_IDS[view]);

    // The back button is added and removed rather than hidden: the stylesheet
    // centers the title by compensating for a back button whenever one precedes
    // it, hidden or not.
    const existing = panel._header.querySelector(".subviewbutton-back");
    if (view === "list") {
      existing?.remove();
      return;
    }
    if (existing) {
      return;
    }
    const backButton = doc.createXULElement("toolbarbutton");
    backButton.className =
      "subviewbutton subviewbutton-iconic subviewbutton-back";
    backButton.setAttribute("tabindex", "0");
    backButton.setAttribute("closemenu", "none");
    backButton.setAttribute(
      "aria-label",
      lazy.gBundle.GetStringFromName("panel.back")
    );
    backButton.addEventListener("command", () => this._setView(panel, "list"));
    panel._header.prepend(backButton);
  },

  /**
   * @param {XULElement} panel
   */
  async _syncContents(panel) {
    let monitors;
    try {
      monitors = await lazy.MonitorAgent.listMonitors();
    } catch (error) {
      console.error("Failed to list monitors:", error);
      return;
    }
    // The panel can close while the monitors are being read.
    if (!panel.isConnected) {
      return;
    }
    panel._contents.monitors = monitors
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(monitor => lazy.MonitorUIUtils.formatMonitorForDisplay(monitor));
  },

  /**
   * @param {XULElement} panel
   * @param {object} detail - See agent-monitor-item's ":submit" event.
   */
  async _onCreateSubmit(panel, detail) {
    const { monitorName, condition, watchUrls, schedule } = detail;
    let id;
    try {
      id = await lazy.MonitorAgent.createMonitor({
        prompt: condition,
        watchUrls,
        pageTitle: monitorName,
        schedule: this._toAgentSchedule(schedule),
        source: "toolbar_panel",
      });
    } catch (error) {
      console.error("Failed to create monitor:", error);
      return;
    }
    if (!panel.isConnected) {
      return;
    }
    panel._contents.draft = null;
    panel._contents.justCreatedId = id;
    this._setView(panel, "list");
    // createMonitor notifies observers, which refreshes the list.
  },

  /**
   * agent-monitor-item reports the schedule the way its form is laid out, which
   * is not the shape MonitorAgent stores.
   *
   * @param {?object} schedule
   * @returns {?object}
   */
  _toAgentSchedule(schedule) {
    if (!schedule) {
      return null;
    }
    const [hour, minute] = schedule.time.split(":").map(Number);
    return {
      type: schedule.frequency,
      hour,
      minute,
      ...(schedule.weekday != null && { weekday: Number(schedule.weekday) }),
    };
  },
};
