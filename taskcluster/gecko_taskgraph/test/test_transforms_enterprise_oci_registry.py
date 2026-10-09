# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import pytest
from mozunit import main

from gecko_taskgraph.test.conftest import FakeParameters
from gecko_taskgraph.transforms import enterprise_oci_registry as oci

# What the kind defaults `REGISTRY_REFERENCE` to.
DEV_REFERENCE = (
    "harbor.stage.fx-enterprise.nonprod.webservices.mozgcp.net"
    "/enterprise-shipit-dev/firefox"
)
# What a partner declares in its repack.cfg, as an https url.
PARTNER_REGISTRY = "https://registry.partner.example.com/firefox/enterprise"
PARTNER_REFERENCE = "registry.partner.example.com/firefox/enterprise"

# As the manifest resolves it: `generic` is the un-customized repack and
# declares no registry, the others publish to one.
PARTNER_CONFIG = {
    "enterprise-repack-repackage": {
        "smp": {
            "generic": {"locales": ["en-US", "fr"]},
            "prodGCP": {
                "locales": ["en-US", "fr"],
                "registry_reference": PARTNER_REGISTRY,
            },
            "stageGCP": {
                "locales": ["en-US", "fr"],
                "registry_reference": PARTNER_REGISTRY,
            },
        },
    },
}

REPACK_CONFIGS = ("smp/generic", "smp/prodGCP", "smp/stageGCP")


def params(level="1", **extra):
    return FakeParameters({
        "level": level,
        "project": "enterprise-firefox",
        "head_ref": "refs/heads/enterprise-main",
        "release_partner_config": PARTNER_CONFIG,
        **extra,
    })


def tasks(repack_configs=REPACK_CONFIGS):
    return [
        {
            "name": repack_config.replace("/", "-"),
            "extra": {"repack_config": repack_config},
            "worker": {"env": {"REGISTRY_REFERENCE": DEV_REFERENCE}},
        }
        for repack_config in repack_configs
    ]


def repacks(results):
    return [task["extra"]["repack_config"] for task in results]


@pytest.mark.parametrize("level", ("1", "3"))
def test_a_repack_without_a_registry_is_not_uploaded(run_transform, level):
    """No `registry_reference` in repack.cfg means the repack is published
    nowhere, not even to the dev registry the kind defaults to."""
    result = run_transform(
        oci.drop_repacks_without_a_registry,
        tasks(),
        kind=oci.UPLOAD_KIND,
        params=params(level),
    )
    assert repacks(result) == ["smp/prodGCP", "smp/stageGCP"]


def test_the_tag_kind_is_left_alone(run_transform):
    """Tag tasks are generated one per upload task, so an unpublished repack
    has none by the time this runs."""
    result = run_transform(
        oci.drop_repacks_without_a_registry,
        tasks(),
        kind="enterprise-oci-tag",
        params=params(),
    )
    assert repacks(result) == list(REPACK_CONFIGS)


def test_a_production_release_publishes_to_the_partner_registry(run_transform):
    result = run_transform(
        oci.set_registry_reference,
        tasks(("smp/prodGCP",)),
        kind=oci.UPLOAD_KIND,
        params=params(level="3"),
        graph_config={"release-branches": {"enterprise-firefox": True}},
    )
    assert [t["worker"]["env"]["REGISTRY_REFERENCE"] for t in result] == [
        PARTNER_REFERENCE
    ]


def test_a_non_production_release_keeps_the_dev_registry(run_transform):
    """A partner registry is only ever reached from a production release, so
    the partner's own reference is not even looked at here."""
    result = run_transform(
        oci.set_registry_reference,
        tasks(("smp/prodGCP",)),
        kind=oci.UPLOAD_KIND,
        params=params(level="1"),
        graph_config={"release-branches": {"enterprise-firefox": True}},
    )
    assert [t["worker"]["env"]["REGISTRY_REFERENCE"] for t in result] == [DEV_REFERENCE]


def test_a_registry_naming_no_repository_is_refused(run_transform):
    partner_config = {
        "enterprise-repack-repackage": {
            "smp": {"prodGCP": {"registry_reference": "https://registry.example.com"}}
        }
    }
    with pytest.raises(Exception, match="names no repository"):
        list(
            run_transform(
                oci.set_registry_reference,
                tasks(("smp/prodGCP",)),
                kind=oci.UPLOAD_KIND,
                params=params(level="3", release_partner_config=partner_config),
                graph_config={"release-branches": {"enterprise-firefox": True}},
            )
        )


if __name__ == "__main__":
    main()
