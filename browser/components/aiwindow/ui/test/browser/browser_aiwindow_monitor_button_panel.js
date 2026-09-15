/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const WIDGET_ID = "smartwindow-monitor-button";
const PANEL_ID = "smartwindow-monitor-panel";
const TEST_REGION = "US";

const { TOTAL_NUM_MONITORS, MONITOR_CONDITION_MET_TOPIC } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/agents/Monitor.sys.mjs"
  );

const { MonitorAgent } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/agents/MonitorAgent.sys.mjs"
);

function notifyMatch(monitorId) {
  Services.obs.notifyObservers(null, MONITOR_CONDITION_MET_TOPIC, monitorId);
}

add_setup(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.search.suggest.enabled", false],
      ["browser.urlbar.suggest.searches", false],
      ["browser.smartwindow.endpoint", "http://localhost:0/v1"],
      ["browser.smartwindow.firstrun.hasCompleted", true],
      ["browser.smartwindow.agent.enabled", true],
      ["browser.smartwindow.agent.toolbar.enabled", true],
      ["browser.smartwindow.agent.supportedRegions", TEST_REGION],
    ],
  });

  // Pin the home region, otherwise the region gate decides whether the button
  // exists at all and every test here becomes a coin toss.
  const originalRegion = Region.home;
  Region._setHomeRegion(TEST_REGION, false);

  AIWindow._updateMonitorWidgetRegistration();

  registerCleanupFunction(() => {
    Region._setHomeRegion(originalRegion, false);
    Services.prefs.clearUserPref(
      "browser.smartwindow.lastSmartWindowUsageTime"
    );
    Services.prefs.clearUserPref("browser.smartwindow.lastLLMTelemetryRunTime");
  });
});

function getMonitorButton(win) {
  return win.document.getElementById(WIDGET_ID);
}

/**
 * Clicking the button opens a panel anchored to it, and clicking again closes
 * it. The panel is removed from the DOM once hidden.
 */
add_task(async function test_monitor_panel_toggles() {
  const win = await openAIWindow();
  try {
    await promiseNavigateAndLoad(
      win.gBrowser.selectedBrowser,
      "https://example.com/"
    );

    const monitorButton = getMonitorButton(win);
    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(monitorButton, {}, win);
    const panel = (await shown).target;

    Assert.equal(panel.id, PANEL_ID, "Clicking the button opens the panel");
    Assert.equal(
      panel.anchorNode?.id,
      WIDGET_ID,
      "Panel is anchored to the monitor button"
    );
    Assert.equal(
      monitorButton.getAttribute("aria-expanded"),
      "true",
      "Button reports the panel as expanded"
    );

    const title = panel.querySelector(".panel-header > h1");
    await win.document.l10n.translateFragment(panel);
    Assert.equal(title.textContent, "Tasks", "Panel has a localized title");
    Assert.equal(
      panel.getAttribute("aria-labelledby"),
      title.id,
      "Panel is labelled by its title for assistive technology"
    );

    const contents = panel.querySelector("agent-monitor-panel");
    Assert.ok(contents, "Panel hosts the agent-monitor-panel element");
    await contents.updateComplete;
    Assert.equal(contents.view, "list", "Panel opens on the list view");
    Assert.equal(
      contents.maxMonitors,
      TOTAL_NUM_MONITORS,
      "Contents know how many tasks are allowed"
    );

    // A second click must close the panel and leave it closed: the rollup on
    // mousedown and the command event that follows must not fight each other.
    let reopened = false;
    const onShown = () => {
      reopened = true;
    };
    const popupSet = win.document.getElementById("mainPopupSet");
    popupSet.addEventListener("popupshown", onShown);
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    EventUtils.synthesizeMouseAtCenter(monitorButton, {}, win);
    await hidden;
    await TestUtils.waitForTick();
    popupSet.removeEventListener("popupshown", onShown);
    Assert.ok(!reopened, "Closing click does not reopen the panel");

    Assert.equal(
      win.document.getElementById(PANEL_ID),
      null,
      "Panel is removed from the DOM once hidden"
    );
    Assert.equal(
      monitorButton.getAttribute("aria-expanded"),
      "false",
      "Button reports the panel as collapsed again"
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * The list names each task the user is watching, newest first, and states when
 * it checks rather than when it last ran.
 */
add_task(async function test_monitor_panel_list_rows() {
  const sb = this.sinon.createSandbox();
  sb.stub(MonitorAgent, "listMonitors").resolves([
    {
      id: "monitor-1",
      title: "Concert tickets",
      monitorPrompt: "tickets go on sale",
      watchUrls: ["https://example.com/tickets"],
      enabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      schedule: { type: "weekly", hour: 14, minute: 30, weekday: 3 },
      history: [],
    },
    {
      id: "monitor-2",
      title: "Ticket price",
      monitorPrompt: "price drops",
      watchUrls: ["https://example.com/price"],
      enabled: true,
      createdAt: "2026-02-01T00:00:00.000Z",
      schedule: { type: "daily", hour: 9, minute: 0 },
      history: [],
    },
  ]);
  const win = await openAIWindow();
  try {
    await promiseNavigateAndLoad(
      win.gBrowser.selectedBrowser,
      "https://example.com/"
    );

    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panel = (await shown).target;
    const contents = panel.querySelector("agent-monitor-panel");
    await TestUtils.waitForCondition(() => contents.monitors.length === 2);
    await contents.updateComplete;

    const rows = contents.shadowRoot.querySelectorAll(".monitor-row");
    Assert.equal(rows.length, 2, "Every monitor gets a row");
    Assert.deepEqual(
      [...rows].map(row => row.querySelector(".monitor-row-title").textContent),
      ["Ticket price", "Concert tickets"],
      "Rows name the monitors, newest first"
    );

    const metas = [...rows].map(row => row.querySelector(".monitor-row-meta"));
    Assert.deepEqual(
      metas.map(meta => meta.getAttribute("data-l10n-id")),
      [
        "ai-tasks-alert-schedule-daily-at",
        "ai-tasks-alert-schedule-weekly-wednesday",
      ],
      "Rows state the schedule the monitor checks on"
    );
    Assert.deepEqual(
      metas.map(meta => JSON.parse(meta.getAttribute("data-l10n-args")).time),
      [
        new Date(new Date().setHours(9, 0, 0, 0)).getTime(),
        new Date(new Date().setHours(14, 30, 0, 0)).getTime(),
      ],
      "The scheduled time of day is passed to the string"
    );
    await TestUtils.waitForCondition(() => metas.every(m => m.textContent));

    const chips = [...rows].map(row =>
      row.querySelector("monitor-status-chip")
    );
    Assert.deepEqual(
      chips.map(chip => chip.kind),
      ["watching", "paused"],
      "Rows wear the same status pill the task cards do"
    );
    await TestUtils.waitForCondition(() =>
      chips.every(chip => chip.shadowRoot.querySelector("span")?.textContent)
    );
    Assert.deepEqual(
      chips.map(chip => chip.shadowRoot.querySelector("span").textContent),
      ["Active", "Paused"],
      "The pills are localized inside the panel"
    );

    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  } finally {
    sb.restore();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * Clicking a monitor row opens the tasks page and dismisses the panel.
 */
add_task(async function test_monitor_panel_row_opens_tasks_page() {
  const sb = this.sinon.createSandbox();
  sb.stub(MonitorAgent, "listMonitors").resolves([
    {
      id: "monitor-1",
      title: "Concert tickets",
      monitorPrompt: "tickets go on sale",
      watchUrls: ["https://example.com/tickets"],
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      schedule: { type: "daily", hour: 9, minute: 0 },
      history: [],
    },
  ]);
  const win = await openAIWindow();
  const switchToTab = sb.stub(win, "switchToTabHavingURI");
  try {
    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panel = (await shown).target;
    const contents = panel.querySelector("agent-monitor-panel");
    await TestUtils.waitForCondition(() => contents.monitors.length === 1);
    await contents.updateComplete;

    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    contents.shadowRoot.querySelector(".monitor-row").click();
    await hidden;

    Assert.ok(
      switchToTab.calledWith("about:smartwindowtasks", true),
      "Clicking a row opens the tasks page and dismisses the panel"
    );
  } finally {
    sb.restore();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * Monitors that newly matched since the panel was last opened are pulled into a
 * "New matches" section above "Recent", and their Match result wears a green dot.
 * Opening consumes the match, so reopening drops the section and the monitor
 * falls back under "Recent".
 */
add_task(async function test_monitor_panel_new_matches_section() {
  const sb = this.sinon.createSandbox();
  sb.stub(MonitorAgent, "listMonitors").resolves([
    {
      id: "monitor-1",
      title: "Concert tickets",
      monitorPrompt: "tickets go on sale",
      watchUrls: ["https://example.com/tickets"],
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      schedule: { type: "daily", hour: 9, minute: 0 },
      history: [],
    },
    {
      id: "monitor-2",
      title: "Ticket price",
      monitorPrompt: "price drops",
      watchUrls: ["https://example.com/price"],
      enabled: true,
      createdAt: "2026-02-01T00:00:00.000Z",
      schedule: { type: "daily", hour: 9, minute: 0 },
      history: [{ conditionMet: true }],
    },
  ]);
  const win = await openAIWindow();
  try {
    notifyMatch("monitor-2");
    await TestUtils.waitForCondition(() => AIWindow.hasMonitorAttention);

    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panel = (await shown).target;
    const contents = panel.querySelector("agent-monitor-panel");
    await TestUtils.waitForCondition(() => contents.monitors.length === 2);
    await contents.updateComplete;

    const labels = [
      ...contents.shadowRoot.querySelectorAll(".monitor-section-label"),
    ];
    Assert.deepEqual(
      labels.map(label => label.getAttribute("data-l10n-id")),
      [
        "smartwindow-monitor-panel-new-matches",
        "smartwindow-monitor-panel-watching",
      ],
      "The New matches section is listed above Recent"
    );

    const sections = [...contents.shadowRoot.querySelectorAll(".monitor-rows")];
    Assert.deepEqual(
      [...sections[0].querySelectorAll(".monitor-row-title")].map(
        title => title.textContent
      ),
      ["Ticket price"],
      "The newly matched monitor is under New matches"
    );
    Assert.deepEqual(
      [...sections[1].querySelectorAll(".monitor-row-title")].map(
        title => title.textContent
      ),
      ["Concert tickets"],
      "The rest stay under Recent"
    );

    Assert.ok(
      sections[0].querySelector(
        ".monitor-row-result.match .monitor-row-match-dot"
      ),
      "The matched row shows a green dot beside its Match status"
    );

    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;

    // Opening consumed the match, so reopening has no New matches section and the
    // monitor now sits under Recent.
    const shownAgain = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panelAgain = (await shownAgain).target;
    const contentsAgain = panelAgain.querySelector("agent-monitor-panel");
    await TestUtils.waitForCondition(() => contentsAgain.monitors.length === 2);
    await contentsAgain.updateComplete;

    Assert.deepEqual(
      [
        ...contentsAgain.shadowRoot.querySelectorAll(".monitor-section-label"),
      ].map(label => label.getAttribute("data-l10n-id")),
      ["smartwindow-monitor-panel-watching"],
      "Reopening drops the New matches section"
    );
    Assert.deepEqual(
      [...contentsAgain.shadowRoot.querySelectorAll(".monitor-row-title")].map(
        title => title.textContent
      ),
      ["Ticket price", "Concert tickets"],
      "The previously new match now sits under Recent with the others"
    );
    Assert.ok(
      !contentsAgain.shadowRoot.querySelector(".monitor-row-match-dot"),
      "The green dot is gone once the match moved back to Recent"
    );

    const hiddenAgain = BrowserTestUtils.waitForEvent(
      panelAgain,
      "popuphidden"
    );
    panelAgain.hidePopup();
    await hiddenAgain;
  } finally {
    sb.restore();
    AIWindow.clearMonitorAttention();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * "Create new task" swaps the panel to the agent-monitor-item create form, and
 * submitting it creates a monitor through MonitorAgent and returns to the list.
 */
add_task(async function test_monitor_panel_create_view() {
  const sb = this.sinon.createSandbox();
  const createMonitor = sb.stub(MonitorAgent, "createMonitor").resolves("id-1");
  sb.stub(MonitorAgent, "listMonitors").resolves([]);
  const win = await openAIWindow();
  try {
    await promiseNavigateAndLoad(
      win.gBrowser.selectedBrowser,
      "https://example.com/"
    );

    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panel = (await shown).target;
    const contents = panel.querySelector("agent-monitor-panel");
    await contents.updateComplete;

    contents.shadowRoot.querySelector(".monitor-footer-row").click();
    await contents.updateComplete;

    Assert.equal(contents.view, "create", "Panel switches to the create view");
    const form = contents.shadowRoot.querySelector("agent-monitor-item");
    Assert.ok(form, "Create view renders the monitor item form");
    Assert.equal(form.mode, "create", "Monitor item is in create mode");
    Assert.ok(
      !form.selfContained,
      "The panel frames and titles the form itself"
    );

    form.dispatchEvent(
      new win.CustomEvent("agent-monitor-item:submit", {
        detail: {
          mode: "create",
          monitorName: "Ticket price",
          condition: "price drops",
          watchUrls: ["https://example.com/"],
          schedule: { frequency: "weekly", time: "09:30", weekday: 3 },
        },
        bubbles: true,
        composed: true,
      })
    );
    await TestUtils.waitForCondition(() => contents.view === "list");

    Assert.ok(createMonitor.calledOnce, "Submitting creates one monitor");
    Assert.deepEqual(
      createMonitor.firstCall.args[0],
      {
        prompt: "price drops",
        watchUrls: ["https://example.com/"],
        pageTitle: "Ticket price",
        schedule: { type: "weekly", hour: 9, minute: 30, weekday: 3 },
        source: "toolbar_panel",
      },
      "Form values are mapped to the shape MonitorAgent stores"
    );
    Assert.equal(
      contents.justCreatedId,
      "id-1",
      "The new monitor is named so its row can animate in"
    );

    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  } finally {
    sb.restore();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * The create form opens watching the page the user is on, unless that page is
 * one a monitor cannot watch.
 */
add_task(async function test_monitor_panel_create_seeds_current_page() {
  const sb = this.sinon.createSandbox();
  sb.stub(MonitorAgent, "listMonitors").resolves([]);
  const win = await openAIWindow();

  const openCreateForm = async () => {
    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panel = (await shown).target;
    const contents = panel.querySelector("agent-monitor-panel");
    await contents.updateComplete;
    contents.shadowRoot.querySelector(".monitor-footer-row").click();
    await contents.updateComplete;
    const form = contents.shadowRoot.querySelector("agent-monitor-item");
    await form.updateComplete;
    return { panel, form };
  };

  const closePanel = async panel => {
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  };

  const pageChips = form =>
    form.shadowRoot.querySelectorAll(".page-pills-row ai-website-chip");

  try {
    await promiseNavigateAndLoad(
      win.gBrowser.selectedBrowser,
      "https://example.com/"
    );

    let { panel, form } = await openCreateForm();
    // pageUrls is seeded a render before the chip is drawn, so wait for it.
    await TestUtils.waitForCondition(
      () => pageChips(form).length === 1,
      "Waiting for the seeded page to render as a chip"
    );
    Assert.deepEqual(
      form.pageUrls,
      ["https://example.com/"],
      "The form opens watching the page the user is on"
    );
    Assert.equal(
      pageChips(form).length,
      1,
      "The seeded page is shown as a chip, so the user can drop it"
    );
    await closePanel(panel);

    await promiseNavigateAndLoad(win.gBrowser.selectedBrowser, "about:robots");
    ({ panel, form } = await openCreateForm());
    Assert.deepEqual(
      form.pageUrls,
      [],
      "A page no monitor can watch seeds nothing"
    );
    await closePanel(panel);
  } finally {
    sb.restore();
    await BrowserTestUtils.closeWindow(win);
  }
});

/**
 * The panel header names whichever view is showing and only offers a back button
 * while there is somewhere to go back to.
 */
add_task(async function test_monitor_panel_header_follows_view() {
  const sb = this.sinon.createSandbox();
  sb.stub(MonitorAgent, "listMonitors").resolves([]);
  const win = await openAIWindow();
  try {
    await promiseNavigateAndLoad(
      win.gBrowser.selectedBrowser,
      "https://example.com/"
    );

    const shown = BrowserTestUtils.waitForEvent(
      win.document.getElementById("mainPopupSet"),
      "popupshown"
    );
    EventUtils.synthesizeMouseAtCenter(getMonitorButton(win), {}, win);
    const panel = (await shown).target;
    const contents = panel.querySelector("agent-monitor-panel");
    const title = panel.querySelector(".panel-header > h1 > span");
    await contents.updateComplete;

    Assert.ok(
      !panel.querySelector(".subviewbutton-back"),
      "The list view has no back button"
    );

    const openCreateView = async () => {
      contents.shadowRoot.querySelector(".monitor-footer-row").click();
      await contents.updateComplete;
      await win.document.l10n.translateFragment(panel);
    };

    await openCreateView();
    Assert.equal(
      title.textContent,
      "Create new task",
      "Header names the create view"
    );
    const backButton = panel.querySelector(".subviewbutton-back");
    Assert.ok(backButton, "Create view offers a back button");
    Assert.equal(
      backButton.getAttribute("aria-label"),
      "Back",
      "Back button is labelled for assistive technology"
    );

    backButton.doCommand();
    await contents.updateComplete;
    await win.document.l10n.translateFragment(panel);
    Assert.equal(contents.view, "list", "Back returns to the list view");
    Assert.equal(
      title.textContent,
      "Tasks",
      "Header names the list view again"
    );
    Assert.ok(
      !panel.querySelector(".subviewbutton-back"),
      "Back button is removed with the create view so the title stays centered"
    );

    // Cancelling the form is the other way back out of the create view.
    await openCreateView();
    contents.shadowRoot.querySelector("agent-monitor-item").dispatchEvent(
      new win.CustomEvent("agent-monitor-item:cancel", {
        detail: {},
        bubbles: true,
        composed: true,
      })
    );
    await contents.updateComplete;
    await win.document.l10n.translateFragment(panel);
    Assert.equal(contents.view, "list", "Cancelling returns to the list view");
    Assert.equal(
      title.textContent,
      "Tasks",
      "Header follows the cancelled view back"
    );

    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  } finally {
    sb.restore();
    await BrowserTestUtils.closeWindow(win);
  }
});
