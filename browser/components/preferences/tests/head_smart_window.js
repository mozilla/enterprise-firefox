/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* global
  openPreferencesViaOpenPreferencesAPI,
  waitForPaneChange,
*/

/* exported
  openSmartWindowPreferencesPage,
  openSmartWindowPanel,
  openManageMemoriesPanel,
  populateMemories,
*/

async function openSmartWindowPreferencesPage() {
  await openPreferencesViaOpenPreferencesAPI("general", { leaveOpen: true });
  const doc = gBrowser.selectedBrowser.contentDocument;
  const win = doc.ownerGlobal;
  return { doc, win };
}

async function openSmartWindowPanel(doc, win) {
  if (!doc) {
    ({ doc, win } = await openSmartWindowPreferencesPage());
  }

  const paneLoaded = waitForPaneChange("ai");
  const categoryButton = doc.getElementById("category-ai-features");
  categoryButton.scrollIntoView();
  EventUtils.synthesizeMouseAtCenter(categoryButton, {}, win);
  await paneLoaded;

  const personalizeButton = doc.getElementById("personalizeSmartWindowButton");
  personalizeButton.scrollIntoView();
  const panelLoaded = waitForPaneChange("personalizeSmartWindow");
  EventUtils.synthesizeMouseAtCenter(personalizeButton, {}, win);
  await panelLoaded;

  return { doc, win };
}

async function openManageMemoriesPanel(doc, win) {
  if (!doc) {
    ({ doc, win } = await openSmartWindowPanel());
  }

  const manageButton = doc.getElementById("manageMemoriesButton");
  manageButton.scrollIntoView();
  const paneLoaded = waitForPaneChange("manageMemories");
  EventUtils.synthesizeMouseAtCenter(manageButton, {}, win);
  await paneLoaded;

  return { doc, win };
}

async function populateMemories() {
  const { MemoryStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/services/MemoryStore.sys.mjs"
  );

  let memoryOne = await MemoryStore.addMemory({
    memory_summary: "Lorem ipsum dolor sit amet 1",
    category: "interests",
    intent: "general",
    score: 5,
  });
  let memoryTwo = await MemoryStore.addMemory({
    memory_summary: "Lorem ipsum dolor sit amet 2",
    category: "habits",
    intent: "general",
    score: 4,
  });

  registerCleanupFunction(async () => {
    for (const { id } of [memoryOne, memoryTwo]) {
      try {
        await MemoryStore.hardDeleteMemory(id);
      } catch (err) {
        console.error("Failed to delete memory:", id, err);
      }
    }
  });

  return { MemoryStore, memories: [memoryOne, memoryTwo] };
}
