/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from ../../../../../toolkit/components/nimbus/test/unit/head.js */

// Nimbus studies, rollouts and Firefox Labs are disabled on enterprise builds.

const LABS_OPT_IN = NimbusTestUtils.factories.recipe.withFeatureConfig(
  "optin",
  { featureId: "no-feature-firefox-desktop" },
  {
    isRollout: true,
    isFirefoxLabsOptIn: true,
    firefoxLabsTitle: "title",
    firefoxLabsDescription: "description",
    firefoxLabsGroup: "group",
    requiresRestart: false,
  }
);

add_task(async function test_nimbus_disabled() {
  const { cleanup, loader } = await NimbusTestUtils.setupTest({
    init: false,
    storePath: await NimbusTestUtils.createStoreWith(store => {
      NimbusTestUtils.addEnrollmentForRecipe(LABS_OPT_IN, { store });
    }),
    experiments: [LABS_OPT_IN],
    migrationState: NimbusTestUtils.migrationState.UNMIGRATED,
  });

  sinon.spy(loader, "updateRecipes");
  sinon.spy(loader, "setTimer");

  await ExperimentAPI.init();

  Assert.ok(!ExperimentAPI.labsEnabled, "Firefox Labs is disabled");
  Assert.ok(!ExperimentAPI.rolloutsEnabled, "Rollouts are disabled");
  Assert.ok(!ExperimentAPI.studiesEnabled, "Studies are disabled");
  Assert.ok(!ExperimentAPI.enabled, "Nimbus is disabled");

  Assert.ok(!loader._enabled, "The recipe loader is not enabled");
  Assert.ok(loader.setTimer.notCalled, "Recipe polling is not scheduled");
  Assert.ok(loader.updateRecipes.notCalled, "Recipes are not fetched");

  Assert.deepEqual(
    ExperimentAPI.manager.store
      .getAll()
      .filter(e => e.active)
      .map(e => e.slug),
    [],
    "The existing Firefox Labs enrollment is no longer active"
  );
  Assert.deepEqual(
    ExperimentAPI.manager.optIns,
    [],
    "No Firefox Labs opt-ins are offered"
  );

  await NimbusTestUtils.cleanupManager([]);
  await cleanup();
});
