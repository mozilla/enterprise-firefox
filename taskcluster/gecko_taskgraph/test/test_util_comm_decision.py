# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import copy
import json

import pytest
from mozunit import main
from taskgraph.parameters import Parameters

from gecko_taskgraph.actions import registry
from gecko_taskgraph.util import comm_decision
from gecko_taskgraph.util import taskgraph as util_taskgraph

DECISION_ID = "DDDDDDDDDDDDDDDDDDDDDD"
COMM_DECISION_ID = "XXXXXXXXXXXXXXXXXXXXXX"
ACTION_ID = "AAAAAAAAAAAAAAAAAAAAAA"
COMM_TASK_ID = "TTTTTTTTTTTTTTTTTTTTTT"
REV = "8a7d396c7a8bfb881c82226b8fa85636611cfe84"
NESTED_INDEX = f"enterprise.v2.enterprise-firefox.revision.{REV}.taskgraph.comm"

PARAMS = {
    "base_repository": "https://github.com/mozilla/enterprise-firefox",
    "base_rev": "6c50365df54875a4f88cef4f73f37e531b8e3942",
    "head_ref": "refs/heads/enterprise-main",
    "head_repository": "https://github.com/mozilla/enterprise-firefox",
    "head_rev": REV,
    "level": "3",
    "owner": "someone@mozilla.com",
    "project": "enterprise-firefox",
    "pushlog_id": "0",
    "repository_type": "git",
    "tasks_for": "github-push",
}
COMM_PARAMS = dict(
    PARAMS,
    project="enterprise-thunderbird",
    comm_base_repository="https://github.com/thunderbird/thunderbird-desktop",
    comm_base_ref="refs/heads/main",
    comm_base_rev="b38b9f797b910623b3b552ef7b400382fa177c42",
    comm_head_repository="https://github.com/thunderbird/thunderbird-desktop",
    comm_head_ref="refs/heads/main",
    comm_head_rev="b38b9f797b910623b3b552ef7b400382fa177c42",
    nested_graph={"project": "enterprise-firefox", "index": NESTED_INDEX},
)


def make_definition(command_args, env, routes, extra):
    return {
        "taskGroupId": DECISION_ID,
        "schedulerId": "enterprise-level-3",
        "provisionerId": "enterprise-3",
        "workerType": "decision",
        "priority": "very-low",
        "created": "2026-11-06T00:00:00.000Z",
        "deadline": "2026-11-07T00:00:00.000Z",
        "expires": "2027-11-06T00:00:01.000Z",
        "dependencies": [],
        "requires": "all-completed",
        "retries": 5,
        "routes": routes,
        "scopes": [
            "assume:repo:github.com/mozilla/enterprise-firefox:branch:enterprise-main"
        ],
        "tags": {"kind": "decision-task", "project": "enterprise-firefox"},
        "metadata": {
            "name": "Decision Task (push)",
            "description": "The task that creates all of the other tasks",
            "owner": "someone@mozilla.com",
            "source": f"https://github.com/mozilla/enterprise-firefox/raw/{REV}/.taskcluster.yml",
        },
        "payload": {
            "env": dict(
                {
                    "GECKO_BASE_REPOSITORY": PARAMS["base_repository"],
                    "GECKO_BASE_REV": PARAMS["base_rev"],
                    "GECKO_HEAD_REPOSITORY": PARAMS["head_repository"],
                    "GECKO_HEAD_REF": PARAMS["head_ref"],
                    "GECKO_HEAD_REV": REV,
                    "GECKO_REPOSITORY_TYPE": "git",
                    "REPOSITORIES": json.dumps({"gecko": "Mozilla Firefox"}),
                },
                **env,
            ),
            "cache": {
                "enterprise-level-3-enterprise-firefox-checkouts-git-shallow-v1": "/builds/worker/checkouts"
            },
            "image": "mozillareleases/gecko_decision:6.0.0",
            "command": [
                "/builds/worker/bin/run-task-git",
                "--gecko-checkout=/builds/worker/checkouts/gecko",
                "--gecko-shallow-clone",
                "--",
                "bash",
                "-cx",
                "cd /builds/worker/checkouts/gecko && ./mach taskgraph "
                + command_args,
            ],
            "artifacts": {
                "public": {
                    "type": "directory",
                    "path": "/builds/worker/artifacts",
                    "expires": "2027-11-06T00:00:00.000Z",
                },
                "public/docker-contexts": {
                    "type": "directory",
                    "path": "/builds/worker/checkouts/gecko/docker-contexts",
                    "expires": "2026-11-13T00:00:00.000Z",
                },
            },
        },
        "extra": extra,
    }


DECISION_DEF = make_definition(
    "decision --project=enterprise-firefox",
    {},
    [
        "checks",
        f"tc-treeherder.v2.enterprise-main.{REV}",
        "index.enterprise.v2.enterprise-firefox.branch.enterprise-main.latest.taskgraph.decision",
        f"index.enterprise.v2.enterprise-firefox.revision.{REV}.taskgraph.decision",
    ],
    {
        "tasks_for": "github-push",
        "treeherder": {"machine": {"platform": "gecko-decision"}, "symbol": "D"},
    },
)

ACTION_DEF = make_definition(
    "action-callback",
    {
        "ACTION_TASK_GROUP_ID": DECISION_ID,
        "ACTION_TASK_ID": json.dumps(COMM_TASK_ID),
        "ACTION_INPUT": "{}",
        "ACTION_CALLBACK": "retrigger",
    },
    [
        "checks",
        f"tc-treeherder.v2.enterprise-main.{REV}",
        f"index.enterprise.v2.enterprise-firefox.revision.{REV}.taskgraph.actions.{ACTION_ID}",
    ],
    {
        "tasks_for": "action",
        "parent": DECISION_ID,
        "action": {"name": "retrigger"},
        "treeherder": {
            "machine": {"platform": "gecko-decision"},
            "groupSymbol": "AC",
            "symbol": "rt",
        },
    },
)


@pytest.fixture
def task_definitions(monkeypatch):
    definitions = {
        DECISION_ID: DECISION_DEF,
        ACTION_ID: ACTION_DEF,
        COMM_TASK_ID: {"taskGroupId": COMM_DECISION_ID},
    }
    monkeypatch.setattr(
        comm_decision,
        "get_task_definition",
        lambda task_id: copy.deepcopy(definitions[task_id]),
    )
    return definitions


def test_make_comm_decision_task(monkeypatch, graph_config, task_definitions):
    monkeypatch.setenv("TASK_ID", DECISION_ID)
    taskdesc = comm_decision.make_comm_decision_task(
        graph_config, Parameters(strict=False, **PARAMS)
    )
    task = taskdesc["task"]
    env = task["payload"]["env"]

    assert taskdesc["label"] == "comm-decision"
    assert taskdesc["optimization"] is None
    # Copied from the decision task by the replicate transform.
    assert task["taskGroupId"] == DECISION_ID
    assert task["scopes"] == DECISION_DEF["scopes"]
    assert task["payload"]["cache"] == DECISION_DEF["payload"]["cache"]
    assert task["priority"] == "very-low"
    # Revisions put back after the replicate transform removed them.
    assert env["GECKO_HEAD_REV"] == REV
    assert env["GECKO_BASE_REV"] == PARAMS["base_rev"]
    assert env["COMM_HEAD_REPOSITORY"] == (
        "https://github.com/thunderbird/thunderbird-desktop"
    )
    assert env["COMM_HEAD_REF"] == "refs/heads/main"
    assert json.loads(env["TASKGRAPH_NESTED_GRAPH"]) == {
        "project": "enterprise-firefox",
        "index": NESTED_INDEX,
    }
    assert json.loads(env["REPOSITORIES"]) == comm_decision.REPOSITORIES

    command = task["payload"]["command"]
    assert command[3:6] == [
        "--comm-checkout=/builds/worker/checkouts/gecko/comm",
        "--comm-shallow-clone",
        "--",
    ]
    assert "taskgraph decision" in command[-1]
    assert "--project=enterprise-thunderbird" in command[-1]
    assert "--root=comm/taskcluster" in command[-1]
    assert "--allow-parameter-override" not in command[-1]

    assert task["routes"] == [
        "checks",
        f"tc-treeherder.v2.enterprise-main.{REV}",
        "index.enterprise.v2.enterprise-firefox.branch.enterprise-main.latest.taskgraph.comm-decision",
        f"index.{NESTED_INDEX}-decision",
    ]
    assert task["extra"]["treeherder"] == {
        "machine": {"platform": "gecko-decision"},
        "collection": {"opt": True},
        "symbol": "DC",
    }
    assert task["metadata"]["source"].startswith(
        "https://github.com/thunderbird/thunderbird-desktop/raw/"
    )
    assert task["tags"]["project"] == "enterprise-thunderbird"
    assert task["payload"]["artifacts"]["public"]["expires"] == {
        "relative-datestamp": "1 year"
    }


def test_make_comm_decision_task_try(monkeypatch, graph_config, task_definitions):
    monkeypatch.setenv("TASK_ID", DECISION_ID)
    task_definitions[DECISION_ID] = definition = copy.deepcopy(DECISION_DEF)
    definition["payload"]["command"][-1] += " --allow-parameter-override"
    definition["routes"] = [
        route.replace(".enterprise-firefox.", ".enterprise-firefox-try.")
        for route in definition["routes"]
    ]
    params = dict(PARAMS, project="enterprise-firefox-try")
    taskdesc = comm_decision.make_comm_decision_task(
        graph_config, Parameters(strict=False, **params)
    )
    script = taskdesc["task"]["payload"]["command"][-1]
    assert "--project=enterprise-thunderbird-try" in script
    assert "--allow-parameter-override" in script
    assert "--try-task-config-file=comm_try_task_config.json" in script


@pytest.mark.parametrize(
    "task_group_id,parameters",
    (
        # From the Taskcluster UI: the action comes from the comm decision task.
        (COMM_DECISION_ID, COMM_PARAMS),
        # From Treeherder: the action comes from the Gecko decision task.
        (DECISION_ID, PARAMS),
    ),
)
def test_redirect_action_to_nested_graph(
    monkeypatch, task_definitions, task_group_id, parameters
):
    import gecko_taskgraph.actions.util as actions_util

    monkeypatch.setenv("TASK_ID", ACTION_ID)
    monkeypatch.setattr(
        actions_util,
        "get_parameters",
        lambda task_id: {COMM_DECISION_ID: COMM_PARAMS}[task_id],
    )
    created = []
    monkeypatch.setattr(
        actions_util,
        "create_tasks",
        lambda graph_config, to_run, graph, label_to_taskid, params, decision_task_id: (
            created.append((graph[to_run[0]].task, decision_task_id))
        ),
    )

    assert comm_decision.redirect_action_to_nested_graph(
        "taskcluster", task_group_id, COMM_TASK_ID, parameters
    )
    ((task, group),) = created
    env = task["payload"]["env"]
    assert group == COMM_DECISION_ID
    assert env["ACTION_TASK_GROUP_ID"] == COMM_DECISION_ID
    assert env["ACTION_CALLBACK"] == "retrigger"
    assert env["GECKO_HEAD_REV"] == REV
    assert env["COMM_HEAD_REV"] == COMM_PARAMS["comm_head_rev"]
    assert task["scopes"] == ACTION_DEF["scopes"]
    assert "action-callback --root=comm/taskcluster" in task["payload"]["command"][-1]
    assert task["routes"] == [
        "checks",
        f"tc-treeherder.v2.enterprise-main.{REV}",
        {"task-reference": f"index.{NESTED_INDEX}-actions.<self>"},
    ]
    assert task["extra"]["treeherder"]["symbol"] == "rt-comm"


def test_no_redirect_on_gecko_graph(monkeypatch, task_definitions):
    task_definitions[COMM_TASK_ID] = {"taskGroupId": DECISION_ID}
    monkeypatch.setenv("TASK_ID", ACTION_ID)
    assert not comm_decision.redirect_action_to_nested_graph(
        "taskcluster", DECISION_ID, COMM_TASK_ID, PARAMS
    )
    assert not comm_decision.redirect_action_to_nested_graph(
        "taskcluster", DECISION_ID, None, PARAMS
    )


def test_find_decision_task_nested(monkeypatch, graph_config):
    found = []
    monkeypatch.setattr(
        util_taskgraph, "find_task_id", lambda index: found.append(index) or "id"
    )
    util_taskgraph.find_decision_task(COMM_PARAMS, graph_config)
    util_taskgraph.find_decision_task(PARAMS, graph_config)
    assert found == [
        f"{NESTED_INDEX}-decision",
        f"enterprise.v2.enterprise-firefox.revision.{REV}.taskgraph.decision",
    ]


def test_nested_actions_json(graph_config):
    """The actions of a nested graph use the top-level repository's hooks."""
    comm_config = copy.deepcopy(graph_config)
    comm_config._config["project-repo-param-prefix"] = "comm_"
    actions = registry.render_actions_json(
        Parameters(strict=False, **COMM_PARAMS), comm_config, COMM_DECISION_ID
    )["actions"]
    gecko_actions = registry.render_actions_json(
        Parameters(strict=False, **PARAMS), graph_config, DECISION_ID
    )["actions"]
    action = actions[0]
    assert action["hookId"] == gecko_actions[0]["hookId"]
    decision = action["hookPayload"]["decision"]
    assert decision["action"]["taskGroupId"] == COMM_DECISION_ID
    assert decision["repository"] == {
        "url": PARAMS["head_repository"],
        "project": "enterprise-firefox",
        "level": "3",
        "base_url": PARAMS["base_repository"],
    }
    assert decision["push"]["revision"] == REV
    assert decision["push"]["base_revision"] == PARAMS["base_rev"]


if __name__ == "__main__":
    main()
