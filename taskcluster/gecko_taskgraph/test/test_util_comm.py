# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os

import pytest
from mozunit import main
from taskgraph.config import GraphConfig

from gecko_taskgraph import GECKO
from gecko_taskgraph.actions.comm_decision import (
    comm_decision_command,
    comm_decision_index_paths,
    is_comm_decision_available,
)
from gecko_taskgraph.actions.registry import (
    comm_action_parameters,
    taskcluster_yml_path,
)
from gecko_taskgraph.util import comm

REV = "718b4b4559717aa5d11304c7ea58901c3e8f9aac"


def params(**kwargs):
    p = {
        "project": "enterprise-firefox",
        "repository_type": "git",
        "tasks_for": "github-push",
        "head_ref": "refs/heads/enterprise-main",
        "base_ref": "",
    }
    p.update(kwargs)
    return p


@pytest.mark.parametrize(
    "parameters,expected",
    (
        pytest.param(params(), "refs/heads/main", id="main"),
        pytest.param(
            params(head_ref="refs/heads/enterprise-beta"), "refs/heads/beta", id="beta"
        ),
        pytest.param(params(head_ref="enterprise-release"), "refs/heads/release"),
        pytest.param(
            params(
                tasks_for="github-pull-request",
                head_ref="refs/heads/fix-something",
                base_ref="refs/heads/enterprise-beta",
            ),
            "refs/heads/beta",
            id="pull-request",
        ),
        pytest.param(
            params(project="enterprise-firefox-try", head_ref="refs/heads/try/abc"),
            "refs/heads/main",
            id="try",
        ),
    ),
)
def test_get_comm_ref(parameters, expected):
    assert comm.get_comm_ref(parameters) == expected


@pytest.mark.parametrize(
    "parameters",
    (
        pytest.param(params(tasks_for="cron"), id="cron"),
        pytest.param(params(repository_type="hg"), id="hg"),
        pytest.param(params(project="firefox"), id="other-project"),
    ),
)
def test_get_comm_checkout_none(mocker, parameters):
    resolve = mocker.patch.object(comm, "get_pinned_rev")
    assert comm.get_comm_checkout(parameters) is None
    resolve.assert_not_called()


def test_get_comm_checkout(mocker):
    mocker.patch.object(comm, "get_pinned_rev", return_value=REV)
    assert comm.get_comm_checkout(params()) == {
        "base_repository": comm.COMM_REPOSITORY,
        "base_ref": "refs/heads/main",
        "base_rev": REV,
        "head_repository": comm.COMM_REPOSITORY,
        "head_ref": "refs/heads/main",
        "head_rev": REV,
    }


def test_pinned_revs():
    for branch in comm.COMM_BRANCHES:
        assert len(comm.get_pinned_rev(branch)) == 40


def graph_config(trust_domain, root):
    return GraphConfig({"trust-domain": trust_domain}, os.path.join(GECKO, root))


def test_taskcluster_yml_path():
    gecko_tcyml = os.path.join(GECKO, ".taskcluster.yml")
    assert (
        taskcluster_yml_path(graph_config("enterprise", "comm/taskcluster"))
        == gecko_tcyml
    )
    assert taskcluster_yml_path(graph_config("gecko", "taskcluster")) == gecko_tcyml


CHECKOUT = {
    "base_repository": comm.COMM_REPOSITORY,
    "base_ref": "refs/heads/main",
    "base_rev": REV,
    "head_repository": comm.COMM_REPOSITORY,
    "head_ref": "refs/heads/main",
    "head_rev": REV,
}


def test_comm_action_parameters_gecko():
    gc = graph_config("enterprise", "taskcluster")
    p = params(comm_checkout=CHECKOUT)
    assert comm_action_parameters(p, gc, comm_checkout=False) is None
    result = comm_action_parameters(p, gc, comm_checkout=True)
    assert "root" not in result
    assert result["head_rev"] == REV
    assert comm_action_parameters(params(comm_checkout=None), gc, True) is None


def test_comm_action_parameters_comm_graph():
    gc = graph_config("enterprise", "comm/taskcluster")
    p = params(**{f"comm_{k}": v for k, v in CHECKOUT.items()})
    result = comm_action_parameters(p, gc, comm_checkout=False)
    assert result["root"] == "comm/taskcluster"
    assert result["head_rev"] == REV


def test_comm_action_parameters_not_enterprise():
    gc = graph_config("comm", "comm/taskcluster")
    p = params(**{f"comm_{k}": v for k, v in CHECKOUT.items()})
    assert comm_action_parameters(p, gc, comm_checkout=False) is None


def decision_params(**kwargs):
    p = params(
        owner="someone@mozilla.com",
        level="3",
        pushlog_id="0",
        pushdate=0,
        base_repository="https://github.com/mozilla/enterprise-firefox",
        base_rev="abc",
        head_repository="https://github.com/mozilla/enterprise-firefox",
        head_rev="def",
        comm_checkout=CHECKOUT,
    )
    p.update(kwargs)
    return p


def test_is_comm_decision_available():
    assert is_comm_decision_available(decision_params())
    assert not is_comm_decision_available(decision_params(comm_checkout=None))
    assert not is_comm_decision_available(
        decision_params(comm_head_repository=comm.COMM_REPOSITORY)
    )


def test_comm_decision_command():
    command = comm_decision_command(decision_params())
    assert command[1:4] == ["--log-no-times", "taskgraph", "decision"]
    assert "--root=comm/taskcluster" in command
    assert "--project=enterprise-thunderbird" in command
    assert "--head-rev=def" in command
    assert "--allow-parameter-override" not in command

    command = comm_decision_command(decision_params(project="enterprise-firefox-try"))
    assert "--project=enterprise-thunderbird-try" in command
    assert "--allow-parameter-override" in command


def test_comm_decision_index_paths():
    gc = graph_config("enterprise", "taskcluster")
    assert comm_decision_index_paths(decision_params(), gc) == [
        "enterprise.v2.enterprise-firefox.branch.enterprise-main.latest.taskgraph.comm-decision",
        "enterprise.v2.enterprise-firefox.revision.def.taskgraph.comm-decision",
    ]
    assert comm_decision_index_paths(
        decision_params(tasks_for="github-pull-request"), gc
    ) == ["enterprise.v2.enterprise-firefox-pr.revision.def.taskgraph.comm-decision"]


if __name__ == "__main__":
    main()
