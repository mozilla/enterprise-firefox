# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import pytest
from mozunit import main
from taskgraph.task import Task

from gecko_taskgraph.test.conftest import FakeParameters
from gecko_taskgraph.transforms.enterprise_repack_mar_signing import (
    make_task_description,
)

KIND = "enterprise-repack-repackage-signing"
PLATFORM = "linux64-enterprise-shippable"
PREFIX = "project/enterprise/repacks"
MAR_FORMATS = ["gcp_prod_autograph_hash_only_mar384"]


def repackage_dep(label, extra, locales):
    """An ``enterprise-repack-repackage`` task, as ``chunk_partners`` fans it out.

    Alongside the MARs it publishes the archive the installer is built from, so
    the tests also cover that only the MARs get signed.
    """
    return Task(
        kind="enterprise-repack-repackage",
        label=label,
        attributes={
            "build_platform": PLATFORM,
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
                    "machine": {"platform": PLATFORM},
                    "collection": {"opt": True},
                },
            )
        },
    )


def per_locale_dep():
    """One task per ``{partner}/{sub_config}/{locale}``, as partner repacks do."""
    return repackage_dep(
        f"enterprise-repack-repackage-smp_prodGCP_fr-{PLATFORM}/opt",
        {"repack_id": "smp/prodGCP/fr"},
        ["fr"],
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
    job = {
        "attributes": {"primary-dependency-label": dep.label},
        "index": {"product": "firefox-enterprise"},
        "treeherder-group": "Rpk-Ent-Ms",
    }
    return list(
        run_transform(
            make_task_description,
            [job],
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


def test_per_locale_repack(run_transform):
    task = run(run_transform, per_locale_dep())

    assert task["label"] == f"{KIND}-smp_prodGCP_fr-{PLATFORM}/opt"
    assert task["treeherder"]["symbol"] == "Rpk-Ent-Ms(smp/prodGCP/fr)"
    assert task["attributes"]["locale"] == "fr"
    assert "chunk_locales" not in task["attributes"]
    assert task["extra"] == {"repack_id": "smp/prodGCP/fr"}
    assert signed_paths(task) == [f"{PREFIX}/smp/prodGCP/fr/target.complete.mar"]


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


@pytest.mark.parametrize(
    "dep", (per_locale_dep, per_config_dep), ids=("per-locale", "per-config")
)
def test_common_task_description(run_transform, dep):
    task = run(run_transform, dep())

    assert task["attributes"]["repackage_type"] == KIND
    assert task["attributes"]["shipping_phase"] == "promote"
    assert task["attributes"]["shipping_product"] == "firefox-enterprise"
    assert task["index"]["type"] == "shippable-l10n"
    assert (
        task["index"]["job-name"]
        == f"enterprise-repack-mar-signing-smp-prodGCP-{PLATFORM}"
    )
    assert task["run-on-projects"] == ["enterprise-firefox"]
    assert all(
        upstream["formats"] == MAR_FORMATS
        for upstream in task["worker"]["upstream-artifacts"]
    )


if __name__ == "__main__":
    main()
