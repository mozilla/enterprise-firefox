# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import copy
import json

import pytest
from mozunit import main
from taskgraph.parameters import Parameters

from gecko_taskgraph.util import comm_decision

DECISION_ID = "DDDDDDDDDDDDDDDDDDDDDD"
REV = "8a7d396c7a8bfb881c82226b8fa85636611cfe84"

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
                "cd /builds/worker/checkouts/gecko && ./mach taskgraph " + command_args,
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

COMM_REV_FILE_CONTENT = """\
base-repository: https://github.com/thunderbird/thunderbird-desktop
head-repository: https://github.com/thunderbird/thunderbird-desktop
refs:
    enterprise-main: refs/heads/main
    enterprise-beta: refs/heads/beta
    enterprise-release: refs/heads/release
    default: refs/heads/main
base-rev: b38b9f797b910623b3b552ef7b400382fa177c42
head-rev: b38b9f797b910623b3b552ef7b400382fa177c42
"""


@pytest.fixture
def task_definitions(monkeypatch, tmp_path):
    # Independent of the revision the tree pins.
    comm_rev = tmp_path / ".comm_rev.yml"
    comm_rev.write_text(COMM_REV_FILE_CONTENT)
    monkeypatch.setattr(comm_decision, "COMM_REV_FILE", str(comm_rev))
    definitions = {DECISION_ID: DECISION_DEF}
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
        f"index.enterprise.v2.enterprise-firefox.revision.{REV}.taskgraph.comm-decision",
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


def test_get_comm_env(monkeypatch, tmp_path):
    comm_rev = tmp_path / ".comm_rev.yml"
    comm_rev.write_text(
        "base-repository: https://github.com/thunderbird/thunderbird-desktop\n"
        "head-repository: https://github.com/someone/thunderbird-desktop\n"
        "refs:\n"
        "    enterprise-beta: refs/heads/beta\n"
        "    default: refs/heads/main\n"
        "base-rev: aaaa\n"
        "head-rev: bbbb\n"
    )
    monkeypatch.setattr(comm_decision, "COMM_REV_FILE", str(comm_rev))
    assert comm_decision.get_comm_env("refs/heads/enterprise-beta") == {
        "COMM_BASE_REPOSITORY": "https://github.com/thunderbird/thunderbird-desktop",
        "COMM_BASE_REF": "refs/heads/beta",
        "COMM_BASE_REV": "aaaa",
        "COMM_HEAD_REPOSITORY": "https://github.com/someone/thunderbird-desktop",
        "COMM_HEAD_REF": "refs/heads/beta",
        "COMM_HEAD_REV": "bbbb",
        "COMM_REPOSITORY_TYPE": "git",
    }
    assert (
        comm_decision.get_comm_env("refs/heads/some-feature")["COMM_HEAD_REF"]
        == "refs/heads/main"
    )


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


if __name__ == "__main__":
    main()
