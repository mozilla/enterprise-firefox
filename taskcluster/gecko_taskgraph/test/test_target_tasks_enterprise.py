# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import pytest
from mozunit import main
from taskgraph.graph import Graph
from taskgraph.task import Task
from taskgraph.taskgraph import TaskGraph

from gecko_taskgraph import target_tasks

# The `{partner}/{sub_config}` repack configs the enterprise manifest hands
# out. `moz` and `hosted` are what `enterprise-firefox` resolves to, `smp` is
# the test partner `enterprise-firefox-try` uses.
REPACK_CONFIGS = (
    "moz/generic",
    "moz/prodGCP",
    "moz/stageGCP",
    "hosted/pilotProd",
    "hosted/pilotStage",
    "smp/prodGCP",
    "smp/stageGCP",
)

PARAMETERS = {"release_product": "firefox-enterprise"}

NOT_A_REPACK = "build-linux64-enterprise-shippable/opt"

# The phase each per-repack kind runs in. The release promotion flavors select
# on it, the nightly ignores it.
REPACK_KINDS = {
    "enterprise-repack-repackage": "promote",
    "enterprise-oci-upload": "push",
    "enterprise-oci-tag": "ship",
}


def _task(kind, label, repack_config=None, **attributes):
    attributes = {
        "shippable": True,
        "shipping_product": "firefox-enterprise",
        **attributes,
    }
    extra = {"repack_config": repack_config} if repack_config else {}
    return Task(kind=kind, label=label, attributes=attributes, task={"extra": extra})


@pytest.fixture(autouse=True)
def no_cron_index(monkeypatch):
    """Without this the nightly bails out as soon as its index exists."""
    monkeypatch.setattr(target_tasks, "cron_index_exists", lambda *args, **kw: False)


@pytest.fixture
def graph():
    """One upload and one tag task per repack config, plus a task that is not
    fanned out per repack and so belongs to every variant."""
    tasks = {
        NOT_A_REPACK: _task("build", NOT_A_REPACK, shipping_phase="build"),
    }
    for repack_config in REPACK_CONFIGS:
        for kind, phase in REPACK_KINDS.items():
            label = f"{kind}-{repack_config.replace('/', '-')}"
            tasks[label] = _task(kind, label, repack_config, shipping_phase=phase)
    return TaskGraph(tasks=tasks, graph=Graph(nodes=set(tasks), edges=set()))


def repacks_of(labels, kind):
    """The repack configs `kind` was scheduled for, read back off the labels."""
    prefix = f"{kind}-"
    return sorted(
        label[len(prefix) :].replace("-", "/", 1)
        for label in labels
        if label.startswith(prefix)
    )


def test_nightly_schedules_upload_and_tag(graph):
    """What a nightly ends up with, as the union of its three variants."""
    labels = target_tasks.target_tasks_nightly_enterprise(graph, PARAMETERS, {})

    assert repacks_of(labels, "enterprise-oci-upload") == [
        "moz/prodGCP",
        "moz/stageGCP",
        "smp/prodGCP",
        "smp/stageGCP",
    ]
    assert repacks_of(labels, "enterprise-oci-tag") == [
        "moz/stageGCP",
        "smp/prodGCP",
        "smp/stageGCP",
    ]


def test_smp_is_tagged_on_both_gcp_targets(graph):
    labels = target_tasks.target_tasks_nightly_enterprise_try(graph, PARAMETERS, {})

    assert repacks_of(labels, "enterprise-oci-upload") == [
        "smp/prodGCP",
        "smp/stageGCP",
    ]
    assert repacks_of(labels, "enterprise-oci-tag") == ["smp/prodGCP", "smp/stageGCP"]


def test_moz_is_tagged_on_stage_only(graph):
    """`moz/prodGCP` reaches the registry but must not be tagged there: the
    prod variant exists to upload without moving the tag users follow."""
    stage = target_tasks.target_tasks_nightly_enterprise_stage(graph, PARAMETERS, {})
    prod = target_tasks.target_tasks_nightly_enterprise_prod(graph, PARAMETERS, {})

    assert repacks_of(stage, "enterprise-oci-upload") == ["moz/stageGCP"]
    assert repacks_of(stage, "enterprise-oci-tag") == ["moz/stageGCP"]

    assert repacks_of(prod, "enterprise-oci-upload") == ["moz/prodGCP"]
    assert repacks_of(prod, "enterprise-oci-tag") == []


@pytest.mark.parametrize("kind", ("enterprise-oci-upload", "enterprise-oci-tag"))
def test_generic_sub_config_is_never_scheduled(graph, kind):
    """`moz/generic` is the un-customized repack; no registry wants it."""
    labels = target_tasks.target_tasks_nightly_enterprise(graph, PARAMETERS, {})
    assert "moz/generic" not in repacks_of(labels, kind)


@pytest.mark.parametrize("kind", ("enterprise-oci-upload", "enterprise-oci-tag"))
def test_hosted_partner_is_not_scheduled(graph, kind):
    """`hosted/pilotProd` and `hosted/pilotStage` are in the `enterprise-firefox`
    manifest but in none of the variants' partner/sub_config maps, so the
    nightly neither uploads nor tags them. Asserted to pin the current
    behaviour: scheduling them is a change to those maps, not an accident."""
    labels = target_tasks.target_tasks_nightly_enterprise(graph, PARAMETERS, {})
    assert [r for r in repacks_of(labels, kind) if r.startswith("hosted/")] == []


def test_tasks_without_a_repack_config_are_always_scheduled(graph):
    """The filter only narrows tasks that name a repack; everything else the
    product ships is kept."""
    for method in (
        target_tasks.target_tasks_nightly_enterprise,
        target_tasks.target_tasks_nightly_enterprise_stage,
        target_tasks.target_tasks_nightly_enterprise_prod,
        target_tasks.target_tasks_nightly_enterprise_try,
    ):
        assert NOT_A_REPACK in method(graph, PARAMETERS, {})


def test_other_products_are_not_scheduled(graph):
    """`release_product` gates the whole filter."""
    labels = target_tasks.target_tasks_nightly_enterprise(
        graph, {"release_product": "firefox"}, {}
    )
    assert labels == []


def test_release_promotion_does_not_filter_on_the_repack_config(graph):
    """Unlike the nightly, the promotion flavors select on `shipping_phase`
    alone and never look at the repack config, so they schedule every upload
    and tag task the graph holds.

    What a repack publishes is decided earlier instead: a repack.cfg with no
    `registry_reference` gets no upload task built at all, so there is nothing
    here to select (see
    `enterprise_oci_registry.drop_repacks_without_a_registry`)."""
    push = target_tasks.target_tasks_push_firefox_enterprise(graph, PARAMETERS, {})
    ship = target_tasks.target_tasks_ship_firefox_enterprise(graph, PARAMETERS, {})

    every_config = sorted(REPACK_CONFIGS)
    assert repacks_of(push, "enterprise-oci-upload") == every_config
    assert repacks_of(push, "enterprise-oci-tag") == []
    assert repacks_of(ship, "enterprise-oci-upload") == every_config
    assert repacks_of(ship, "enterprise-oci-tag") == every_config


def test_ship_never_tags_what_push_did_not_upload(graph):
    """Holds whatever the partner/sub_config rules end up being: a tag moves
    the reference users follow, so the image it points at has to have been
    pushed by the same release."""
    push = target_tasks.target_tasks_push_firefox_enterprise(graph, PARAMETERS, {})
    ship = target_tasks.target_tasks_ship_firefox_enterprise(graph, PARAMETERS, {})

    assert set(repacks_of(ship, "enterprise-oci-tag")) <= set(
        repacks_of(push, "enterprise-oci-upload")
    )


def test_nightly_never_tags_what_it_did_not_upload(graph):
    labels = target_tasks.target_tasks_nightly_enterprise(graph, PARAMETERS, {})

    assert set(repacks_of(labels, "enterprise-oci-tag")) <= set(
        repacks_of(labels, "enterprise-oci-upload")
    )


if __name__ == "__main__":
    main()
