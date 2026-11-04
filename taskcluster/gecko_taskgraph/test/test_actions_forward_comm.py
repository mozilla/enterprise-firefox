# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import pytest
from mozunit import main
from taskgraph.parameters import Parameters

from gecko_taskgraph.actions.registry import render_actions_json
from gecko_taskgraph.parameters import COMM_TASKGRAPH_ROOT

COMM_GRAPH = {
    "task_id": "aaaaaaaaaaaaaaaaaaaaaa",
    "root": COMM_TASKGRAPH_ROOT,
    "head_repository": "https://github.com/thunderbird/thunderbird-desktop",
    "head_ref": "refs/heads/main",
    "head_rev": "c0e398ed8f055a7f2e5cadecb1513a6d8708107b",
}


def actions_by_name(graph_config, **parameters):
    rendered = render_actions_json(
        Parameters(strict=False, **parameters), graph_config, "decision-task-id"
    )
    return {action["name"]: action for action in rendered["actions"]}


@pytest.fixture
def forwarded_action(graph_config):
    return actions_by_name(graph_config, comm_graph=COMM_GRAPH)[
        "release-promotion-comm"
    ]


def test_absent_without_comm_graph(graph_config):
    """A push that builds no Thunderbird graph offers nothing to forward."""
    assert "release-promotion-comm" not in actions_by_name(graph_config)


def test_carries_comm_graph_in_hook_payload(forwarded_action):
    """`.taskcluster.yml` reads this back to reach the Thunderbird graph."""
    parameters = forwarded_action["hookPayload"]["decision"]["parameters"]
    assert parameters["comm_graph"] == COMM_GRAPH


def test_rides_the_registered_hook(graph_config, forwarded_action):
    """The point of forwarding: the same hook the other actions already use.

    That hook is named after this repository's `.taskcluster.yml`, which is
    what ci-admin registers -- unlike the comm checkout's, which nothing does.
    """
    generic = actions_by_name(graph_config, comm_graph=COMM_GRAPH)["retrigger"]
    assert forwarded_action["hookGroupId"] == generic["hookGroupId"]
    assert (
        forwarded_action["hookId"].rsplit("/", 1)[1]
        == (generic["hookId"].rsplit("/", 1)[1])
    )
    # Its own permission, though: promoting a release is not `generic`.
    assert forwarded_action["hookId"].startswith("in-tree-action-3-release-promotion/")


if __name__ == "__main__":
    main()
