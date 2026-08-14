/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const TEST_PAGE =
  "chrome://mochitests/content/browser/browser/components/aiwindow/ui/test/browser/test_agent_monitor_item_page.html";

const AGENT = {
  id: "agent-1",
  monitorName: "Sony WH-1000XM5 price",
  url: "soundnest.com/audio/sony-wh-1000xm5",
  condition: "the price drops below $270",
  conditionPresets: ["Any drop", "Below $270", "Below $250"],
  status: { label: "Active", kind: "watching" },
  cadence: "Auto · on-device",
};

async function openTestPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, TEST_PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await content.customElements.whenDefined("agent-monitor-item");
  });
  return { tab, browser: tab.linkedBrowser };
}

async function withTestPage(fn) {
  const { tab, browser } = await openTestPage();
  try {
    await fn(browser);
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

async function setProps(browser, props) {
  await SpecialPowers.spawn(browser, [props], async properties => {
    const el = content.document.getElementById("test-agent-monitor-item");
    Object.assign(el, properties);
    await el.updateComplete;
  });
}

add_task(async function test_display_collapsed_and_expanded() {
  await withTestPage(async browser => {
    await setProps(browser, { agent: AGENT, mode: "display", expanded: false });

    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      Assert.ok(
        shadow.querySelector(".monitor-card.chatcard"),
        "Display mode renders a collapsible monitor card"
      );
      Assert.equal(
        shadow.querySelector(".monitor-card-name").textContent.trim(),
        "Sony WH-1000XM5 price",
        "Head shows the monitor name from the agent property"
      );
      Assert.ok(
        !shadow.querySelector(".watch-expand"),
        "Expanded body is absent when collapsed"
      );

      el.expanded = true;
      await el.updateComplete;

      Assert.ok(
        shadow.querySelector(".watch-expand"),
        "Expanded body appears when expanded is true"
      );
    });
  });
});

add_task(async function test_toggle_dispatches_and_expands() {
  await withTestPage(async browser => {
    await setProps(browser, { agent: AGENT, mode: "display", expanded: false });

    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      const events = [];
      el.addEventListener("agent-monitor-item:toggle", e =>
        events.push(e.detail?.expanded)
      );

      shadow.querySelector(".chev").click();
      await el.updateComplete;

      Assert.equal(
        el.expanded,
        true,
        "Activating the chevron expands the card"
      );
      Assert.deepEqual(
        events,
        [true],
        "toggle event fires with the new expanded value"
      );
    });
  });
});

add_task(async function test_edit_toggle_expands_and_shows_field() {
  await withTestPage(async browser => {
    await setProps(browser, { agent: AGENT, mode: "display", expanded: false });

    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      const events = [];
      el.addEventListener("agent-monitor-item:edit-toggle", e =>
        events.push(e.detail?.editing)
      );

      // First expand the card to reveal the edit button
      shadow.querySelector(".chev").click();
      await el.updateComplete;

      // Now click the edit button
      shadow
        .querySelector('moz-button[data-l10n-id="ai-tasks-alert-edit-button"]')
        .click();
      await el.updateComplete;

      Assert.equal(el.editing, true, "Edit button turns on editing");
      Assert.equal(
        el.expanded,
        true,
        "Opening edit while collapsed also expands the card"
      );
      Assert.ok(
        shadow.querySelector("moz-textarea.monitor-condition-input"),
        "Editable condition field is shown while editing"
      );
      Assert.deepEqual(events, [true], "edit-toggle event fires with editing");
    });
  });
});

add_task(async function test_preset_updates_condition() {
  await withTestPage(async browser => {
    await setProps(browser, {
      agent: AGENT,
      mode: "display",
      expanded: true,
      editing: true,
    });

    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      const chips = shadow.querySelectorAll(".chip");
      chips[2].click(); // "Below $250"
      await el.updateComplete;

      Assert.equal(
        shadow.querySelector("moz-textarea.monitor-condition-input").value,
        "Below $250",
        "Selecting a preset chip updates the condition field"
      );
    });
  });
});

add_task(async function test_submit_and_delete_dispatch_detail() {
  await withTestPage(async browser => {
    await setProps(browser, {
      agent: AGENT,
      mode: "display",
      expanded: true,
      editing: true,
    });

    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      let submitDetail = null;
      let deleteDetail = null;
      el.addEventListener(
        "agent-monitor-item:submit",
        e => (submitDetail = e.detail)
      );
      el.addEventListener(
        "agent-monitor-item:delete",
        e => (deleteDetail = e.detail)
      );

      // Save dispatches submit
      const saveButton = shadow.querySelector(
        'moz-button[data-l10n-id="ai-tasks-alert-save-button"]'
      );
      saveButton.click();
      await el.updateComplete;
      Assert.deepEqual(
        submitDetail,
        {
          mode: "display",
          id: "agent-1",
          monitorName: "Sony WH-1000XM5 price",
          condition: "the price drops below $270",
          watchUrls: ["soundnest.com/audio/sony-wh-1000xm5"],
          schedule: { frequency: "daily", time: "09:00", weekday: 1 },
          autoExpandAndCheck: false,
        },
        "submit carries mode, id, monitor name, condition, watch URLs and schedule"
      );

      const deleteButton = shadow.querySelector(
        'moz-button[data-l10n-id="ai-tasks-alert-delete-button"]'
      );
      deleteButton.click();
      await el.updateComplete;
      Assert.deepEqual(
        deleteDetail,
        { id: "agent-1" },
        "delete carries the agent id"
      );
    });
  });
});

add_task(async function test_pause_button_toggles_label_and_detail() {
  await withTestPage(async browser => {
    await setProps(browser, { agent: AGENT, mode: "display", expanded: true });

    const pausedAgent = {
      ...AGENT,
      status: { label: "Paused", kind: "paused" },
    };

    await SpecialPowers.spawn(browser, [pausedAgent], async pausedAgentArg => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      const pauseDetails = [];
      el.addEventListener("agent-monitor-item:pause", e =>
        pauseDetails.push(e.detail)
      );

      const clickWhenLaidOut = async button => {
        await ContentTaskUtils.waitForCondition(() => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }, "button is laid out before clicking");
        button.click();
      };

      const pauseButton = shadow.querySelector(
        'moz-button[data-l10n-id="ai-tasks-alert-pause-button"]'
      );
      Assert.ok(pauseButton, "Active monitor shows a Pause button");
      await clickWhenLaidOut(pauseButton);
      await el.updateComplete;
      Assert.deepEqual(
        pauseDetails.at(-1),
        { id: "agent-1", paused: true },
        "Pause requests paused: true"
      );

      el.agent = pausedAgentArg;
      await el.updateComplete;

      const resumeButton = shadow.querySelector(
        'moz-button[data-l10n-id="ai-tasks-alert-resume-button"]'
      );
      Assert.ok(resumeButton, "Paused monitor shows a Resume button");
      await clickWhenLaidOut(resumeButton);
      await el.updateComplete;
      Assert.deepEqual(
        pauseDetails.at(-1),
        { id: "agent-1", paused: false },
        "Resume requests paused: false"
      );
    });
  });
});

add_task(async function test_check_now_dispatches_detail() {
  await withTestPage(async browser => {
    await setProps(browser, { agent: AGENT, mode: "display", expanded: true });

    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      let checkDetail = null;
      el.addEventListener(
        "agent-monitor-item:check-now",
        e => (checkDetail = e.detail)
      );

      const checkNowButton = shadow.querySelector(
        'moz-button[data-l10n-id="ai-tasks-alert-check-now-button"]'
      );

      await ContentTaskUtils.waitForCondition(() => {
        const rect = checkNowButton.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }, "Check now button is laid out before clicking");
      checkNowButton.click();
      await el.updateComplete;

      Assert.deepEqual(
        checkDetail,
        { id: "agent-1" },
        "check-now carries the agent id"
      );
    });
  });
});

add_task(async function test_edit_mode_shows_pages_and_scheduler() {
  await withTestPage(async browser => {
    await setProps(browser, {
      agent: AGENT,
      mode: "display",
      expanded: true,
      editing: true,
    });

    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      Assert.equal(
        shadow.querySelectorAll(".page-pill").length,
        1,
        "Edit mode seeds a pill for the monitor's existing URL"
      );
      Assert.ok(
        shadow.querySelector(".page-input-row moz-input-url.page-url-input"),
        "A pending URL input is shown for adding pages"
      );
      Assert.ok(
        shadow.querySelector(".page-input-row moz-button.add-page-btn"),
        "The pending URL input has an add-page button"
      );
      const selects = shadow.querySelectorAll(".schedule-container moz-select");
      Assert.equal(
        selects.length,
        1,
        "Daily edit shows only the frequency select"
      );

      el.checkFrequency = "weekly";
      await el.updateComplete;
      Assert.equal(
        shadow.querySelectorAll(".schedule-container moz-select").length,
        2,
        "Weekly edit reveals the Day select alongside frequency"
      );
    });
  });
});

add_task(async function test_expanded_display_shows_saved_schedule() {
  await withTestPage(async browser => {
    await setProps(browser, {
      agent: {
        ...AGENT,
        cadence: undefined,
        schedule: { frequency: "weekly", time: "09:00", weekday: "1" },
      },
      mode: "display",
      expanded: true,
    });

    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      const checkRow = shadow
        .querySelector('[data-l10n-id^="ai-tasks-alert-schedule-"]')
        ?.closest(".monitor-row");
      Assert.ok(checkRow, "Expanded display shows a Check row");
      Assert.equal(
        checkRow.querySelector("[data-l10n-id]").getAttribute("data-l10n-id"),
        "ai-tasks-alert-schedule-weekly-monday",
        "Check row uses the correct localization ID for weekly Monday schedule"
      );
    });
  });
});

add_task(async function test_create_mode_renders_form() {
  await withTestPage(async browser => {
    await setProps(browser, { agent: AGENT, mode: "create" });

    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      Assert.ok(
        shadow.querySelector(".monitor-card"),
        "Create mode renders a monitor card"
      );
      Assert.ok(
        !shadow.querySelector(".chatcard"),
        "Create mode is not the collapsible chat card"
      );
      Assert.ok(
        shadow.querySelector("moz-textarea.monitor-condition-input"),
        "Create mode shows the condition field"
      );

      let submitDetail = null;
      el.addEventListener(
        "agent-monitor-item:submit",
        e => (submitDetail = e.detail)
      );
      // Start monitoring
      const createButton = shadow.querySelector(
        'moz-button[data-l10n-id="ai-tasks-alert-create-button"]'
      );
      createButton.click();
      await el.updateComplete;

      Assert.equal(
        submitDetail?.mode,
        "create",
        "submit from create mode reports mode 'create'"
      );
    });
  });
});

add_task(async function test_create_mode_empty_state_inputs() {
  await withTestPage(async browser => {
    // when no monitorName or value is available the card should offer editable inputs instead
    await setProps(browser, {
      agent: { conditionPresets: ["Any drop"] },
      mode: "create",
    });

    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      const nameInput = shadow.querySelector(
        "moz-input-text.monitor-name-input"
      );
      Assert.ok(nameInput, "Name input is shown when there is no monitor name");

      const setValue = (input, value) => {
        input.value = value;
        input.dispatchEvent(new content.Event("input", { bubbles: true }));
        input.dispatchEvent(new content.Event("change", { bubbles: true }));
      };

      let submitDetail = null;
      el.addEventListener(
        "agent-monitor-item:submit",
        e => (submitDetail = e.detail)
      );

      const startButton = shadow.querySelector(
        'moz-button[data-l10n-id="ai-tasks-alert-create-button"]'
      );

      startButton.click();
      await el.updateComplete;
      Assert.equal(
        submitDetail,
        null,
        "Submit is blocked while the form is empty"
      );

      setValue(nameInput, "Sony Headphone");
      setValue(
        shadow.querySelector("moz-textarea.monitor-condition-input"),
        "the price drops"
      );

      const urlInput = shadow.querySelector("moz-input-url.page-url-input");
      urlInput.value = "https://example.com/product";
      urlInput.dispatchEvent(new content.Event("input", { bubbles: true }));
      urlInput.dispatchEvent(
        new content.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
      await el.updateComplete;
      Assert.equal(
        shadow.querySelectorAll(".page-pill").length,
        1,
        "Adding a URL shows a pill"
      );

      startButton.click();
      await el.updateComplete;

      Assert.equal(
        submitDetail?.monitorName,
        "Sony Headphone",
        "submit carries the typed monitor name"
      );
      Assert.equal(
        submitDetail?.condition,
        "the price drops",
        "submit carries the typed condition"
      );
      Assert.deepEqual(
        submitDetail?.watchUrls,
        ["https://example.com/product"],
        "submit carries the added page URL"
      );
    });
  });
});

add_task(async function test_add_and_remove_page_pills() {
  await withTestPage(async browser => {
    await setProps(browser, {
      agent: { conditionPresets: [] },
      mode: "create",
    });

    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      Assert.equal(
        shadow.querySelectorAll(".page-pill").length,
        0,
        "Starts with no page pills when nothing is seeded"
      );

      const urlInput = shadow.querySelector("moz-input-url.page-url-input");
      urlInput.value = "https://example.com/a";
      urlInput.dispatchEvent(new content.Event("input", { bubbles: true }));
      shadow.querySelector("moz-button.add-page-btn").click();
      await el.updateComplete;
      Assert.equal(
        shadow.querySelectorAll(".page-pill").length,
        1,
        "Add button adds the typed URL as a pill"
      );

      const removeButton = shadow.querySelector(".page-pill .page-pill-remove");

      await ContentTaskUtils.waitForCondition(() => {
        const rect = removeButton.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }, "Remove button is laid out before clicking");
      removeButton.click();
      await el.updateComplete;
      Assert.equal(
        shadow.querySelectorAll(".page-pill").length,
        0,
        "Pill remove button removes the URL"
      );
    });
  });
});

add_task(async function test_invalid_url_shows_error() {
  await withTestPage(async browser => {
    await setProps(browser, {
      agent: { conditionPresets: [] },
      mode: "create",
    });

    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.getElementById("test-agent-monitor-item");
      const shadow = el.shadowRoot;

      const urlInput = shadow.querySelector("moz-input-url.page-url-input");
      urlInput.value = "not a url";
      urlInput.dispatchEvent(new content.Event("input", { bubbles: true }));
      shadow.querySelector("moz-button.add-page-btn").click();

      // Wait for the async validation to complete and the error message to appear
      await el.updateComplete;
      await ContentTaskUtils.waitForCondition(
        () => shadow.querySelector(".error-message"),
        "Waiting for error message to appear"
      );

      Assert.ok(
        shadow.querySelector(".error-message"),
        "An invalid URL surfaces an error message"
      );
      Assert.equal(
        shadow.querySelectorAll(".page-pill").length,
        0,
        "An invalid URL is not added as a pill"
      );
    });
  });
});
