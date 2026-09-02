# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import pytest
from mozunit import main
from taskgraph.graph import Graph
from taskgraph.task import Task
from taskgraph.taskgraph import TaskGraph

from gecko_taskgraph.filter_tasks import target_tasks_try_auto

KEPT = [
    "build-linux64/opt",
    "test-linux1804-64-qr/opt-mochitest-plain-1",
    "test-macosx64-enterprise/opt-mochitest-plain-1",
]

EXCLUDED_ON_ENTERPRISE = [
    "build-linux64-asan/opt",
    "test-linux1804-64-asan-qr/opt-mochitest-plain-1",
    "test-linux1804-64-tsan-qr/opt-mochitest-plain-1",
    "test-linux1804-64-qr/opt-talos-g1",
    "test-linux1804-64-qr/opt-browsertime-tp6-firefox-amazon",
    "test-windows11-aarch64/opt-mochitest-plain-1",
    "test-macosx1470-64-qr/opt-mochitest-plain-1",
    "test-macosx64-enterprise/opt-mochitest-browser-chrome-1",
]


def _task_graph():
    tasks = {
        label: Task(
            kind=label.split("-")[0],
            label=label,
            attributes={"run_on_projects": ["all"]},
            task={},
        )
        for label in KEPT + EXCLUDED_ON_ENTERPRISE
    }
    return TaskGraph(tasks, Graph(nodes=set(tasks), edges=set()))


def _params(project, try_task_config=None):
    return {
        "project": project,
        "try_task_config": try_task_config or {},
        "repository_type": "git",
        "head_ref": "refs/heads/enterprise-main",
        "hg_branch": "default",
        "level": "1",
        "tasks_for": "github-push",
        "target_tasks_method": "try_auto",
    }


def _selected(project, try_task_config=None):
    return set(
        target_tasks_try_auto(_task_graph(), _params(project, try_task_config), {})
    )


@pytest.mark.parametrize("label", EXCLUDED_ON_ENTERPRISE)
def test_enterprise_try_auto_excludes(label):
    """ENTERPRISE_TRY_AUTO_EXCLUDE_LABELS applies on the Enterprise try repo."""
    assert label not in _selected("enterprise-firefox-try")


@pytest.mark.parametrize("label", KEPT)
def test_enterprise_try_auto_keeps(label):
    assert label in _selected("enterprise-firefox-try")


@pytest.mark.parametrize("label", KEPT + EXCLUDED_ON_ENTERPRISE)
def test_other_projects_are_unaffected(label):
    """The exclusions must not leak onto the upstream try repo."""
    assert label in _selected("try")


def test_caller_supplied_excludes_are_kept():
    """`--tasks-regex-exclude` still applies alongside the enterprise list."""
    config = {"tasks-regex": {"exclude": ["mochitest-plain"]}}
    selected = _selected("enterprise-firefox-try", config)

    assert "test-linux1804-64-qr/opt-mochitest-plain-1" not in selected
    assert "build-linux64/opt" in selected
    assert "test-windows11-aarch64/opt-mochitest-plain-1" not in selected


if __name__ == "__main__":
    main()
