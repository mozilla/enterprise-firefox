# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import pytest
from mozunit import main
from taskgraph.task import Task

from gecko_taskgraph.test.conftest import FakeParameters, FakeTransformConfig
from gecko_taskgraph.transforms import job  # noqa: F401
from gecko_taskgraph.transforms.enterprise_repack_mar_signing import (
    make_task_description,
)
from gecko_taskgraph.transforms.task import MAX_ROUTE_LENGTH, add_index_routes

KIND = "enterprise-repack-repackage-signing"
PLATFORM = "linux64-enterprise-shippable"
PREFIX = "project/enterprise/repacks"
MAR_FORMATS = ["gcp_prod_autograph_hash_only_mar384"]


def repackage_dep(label, extra, locales, platform=PLATFORM):
    """An ``enterprise-repack-repackage`` task, as ``chunk_partners`` fans it out.

    Alongside the MARs it publishes the archive the installer is built from, so
    the tests also cover that only the MARs get signed.
    """
    return Task(
        kind="enterprise-repack-repackage",
        label=label,
        attributes={
            "build_platform": platform,
            "build_type": "opt",
            "shippable": True,
            "shipping_phase": "promote",
            "shipping_product": "firefox-enterprise",
            "run_on_projects": ["enterprise-firefox"],
            "release_artifacts": [
                f"{PREFIX}/{extra.get('repack_config', 'smp/prodGCP')}/{locale}/{name}"
                for locale in locales
                for name in ("target.complete.mar", "target.tar.xz")
            ],
        },
        task={
            "extra": dict(
                extra,
                treeherder={
                    "machine": {"platform": platform},
                    "collection": {"opt": True},
                },
            )
        },
    )


def per_config_dep():
    """One task per ``{partner}/{sub_config}``, as enterprise repacks do."""
    locales = ["de", "en-US", "fr"]
    return repackage_dep(
        f"enterprise-repack-repackage-smp_prodGCP-{PLATFORM}/opt",
        {
            "repack_config": "smp/prodGCP",
            "repack_locales": locales,
            "repack_ids": [f"smp/prodGCP/{locale}" for locale in locales],
        },
        locales,
    )


def run(run_transform, dep):
    job_def = {
        "attributes": {"primary-dependency-label": dep.label},
        "index": {"product": "firefox-enterprise"},
        "treeherder-group": "Rpk-Ent-Ms",
    }
    return list(
        run_transform(
            make_task_description,
            [job_def],
            kind=KIND,
            params=FakeParameters({"level": 1}),
            kind_dependencies_tasks={dep.label: dep},
        )
    )[0]


def signed_paths(task):
    return [
        path
        for upstream in task["worker"]["upstream-artifacts"]
        for path in upstream["paths"]
    ]


def test_per_config_repack(run_transform):
    locales = ["de", "en-US", "fr"]
    task = run(run_transform, per_config_dep())

    assert task["label"] == f"{KIND}-smp_prodGCP-{PLATFORM}/opt"
    assert task["treeherder"]["symbol"] == "Rpk-Ent-Ms(smp/prodGCP)"
    # The index templates append the locale, so every locale of the repack
    # needs a route and none of them may be dropped to a single `locale`.
    assert "locale" not in task["attributes"]
    assert task["attributes"]["chunk_locales"] == locales
    assert task["extra"] == {
        "repack_config": "smp/prodGCP",
        "repack_locales": locales,
    }
    assert signed_paths(task) == [
        f"{PREFIX}/smp/prodGCP/{locale}/target.complete.mar" for locale in locales
    ]


def test_common_task_description(run_transform):
    task = run(run_transform, per_config_dep())

    assert task["attributes"]["repackage_type"] == KIND
    assert task["attributes"]["shipping_phase"] == "promote"
    assert task["attributes"]["shipping_product"] == "firefox-enterprise"
    assert task["index"]["type"] == "shippable-l10n"
    assert (
        task["index"]["job-name"] == "repack-mar-signing-smp-prodGCP-linux64-shippable"
    )
    assert task["run-on-projects"] == ["enterprise-firefox"]
    assert all(
        upstream["formats"] == MAR_FORMATS
        for upstream in task["worker"]["upstream-artifacts"]
    )


def test_a_single_locale_repack_config(run_transform):
    """The l10n index builders prefer `locale` over `chunk_locales`, so a
    config holding one locale must set the singular attribute."""
    dep = repackage_dep(
        f"enterprise-repack-repackage-smp_prodGCP-{PLATFORM}/opt",
        {
            "repack_config": "smp/prodGCP",
            "repack_locales": ["fr"],
            "repack_ids": ["smp/prodGCP/fr"],
        },
        ["fr"],
    )
    task = run(run_transform, dep)

    assert task["attributes"]["locale"] == "fr"
    assert "chunk_locales" not in task["attributes"]
    assert signed_paths(task) == [f"{PREFIX}/smp/prodGCP/fr/target.complete.mar"]


@pytest.mark.parametrize(
    "platform",
    [
        "linux64-enterprise-shippable",
        "linux64-aarch64-enterprise-shippable",
        "macosx64-enterprise-shippable",
        "win64-enterprise-shippable",
        "win64-aarch64-enterprise-shippable",
    ],
)
def test_index_routes_fit_on_release(run_transform, graph_config, platform):
    """Bug 2089727: the routes of the repacks of the longest branch must stay
    within the length Taskcluster accepts."""
    repack = "hosted/pilotStage"
    locales = ["en-US", "ja-JP-mac"]
    dep = repackage_dep(
        f"enterprise-repack-repackage-hosted_pilotStage-{platform}/opt",
        {
            "repack_config": repack,
            "repack_locales": locales,
            "repack_ids": [f"{repack}/{locale}" for locale in locales],
        },
        locales,
        platform=platform,
    )
    task = run(run_transform, dep)

    config = FakeTransformConfig(
        graph_config=graph_config,
        params=FakeParameters({
            "base_repository": "https://github.com/mozilla/enterprise-firefox",
            "build_date": 1793897517,
            "head_ref": "refs/heads/enterprise-release",
            "head_rev": "3c0bbcb6242973611da6d88ea95d5c3cd21f78a8",
            "level": "3",
            "project": "enterprise-firefox",
            "repository_type": "git",
            "tasks_for": "action",
        }),
    )
    task = next(add_index_routes(config, [task]))

    assert task["routes"]
    assert all(len(route) <= MAX_ROUTE_LENGTH for route in task["routes"])
    assert (
        "index.enterprise.v2.enterprise-firefox.branch.enterprise-release."
        "shippable.1793897517.revision.3c0bbcb6242973611da6d88ea95d5c3cd21f78a8."
        "firefox-enterprise-l10n."
        f"repack-mar-signing-hosted-pilotStage-{platform.replace('-enterprise', '')}"
        ".en-US"
    ) in task["routes"]


if __name__ == "__main__":
    main()
