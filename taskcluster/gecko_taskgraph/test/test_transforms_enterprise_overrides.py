# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os

import pytest
from mozunit import main
from taskgraph.util.yaml import load_yaml

from gecko_taskgraph import GECKO
from gecko_taskgraph.transforms.enterprise_overrides import (
    OVERRIDES_FILE,
    apply_enterprise_overrides,
    apply_override,
)

BUILD_KIND_PATH = os.path.join(GECKO, "taskcluster", "kinds", "build")


@pytest.mark.parametrize(
    "task,override,expected",
    (
        pytest.param(
            {"a": {"b": 1, "c": 2}},
            {"a": {"c": 3}},
            {"a": {"b": 1, "c": 3}},
            id="merge-dict",
        ),
        pytest.param(
            {"a": ["x"]}, {"a": ["x", "y"]}, {"a": ["x", "y"]}, id="append-list"
        ),
        pytest.param({"a": 1, "b": 2}, {"a": None}, {"b": 2}, id="remove-key"),
        pytest.param({}, {"a": {"b": [1]}}, {"a": {"b": [1]}}, id="missing-key"),
    ),
)
def test_apply_override(task, override, expected):
    apply_override(task, override)
    assert task == expected


def test_unknown_task(run_transform, tmp_path):
    (tmp_path / OVERRIDES_FILE).write_text(
        "missing/opt:\n    run-on-projects: [enterprise-firefox]\n"
    )
    with pytest.raises(Exception, match="missing/opt"):
        list(
            run_transform(
                apply_enterprise_overrides,
                [{"name": "linux64/opt"}],
                path=str(tmp_path),
            )
        )


def test_build_overrides(run_transform):
    names = load_yaml(BUILD_KIND_PATH, OVERRIDES_FILE)
    tasks = [
        {
            "name": name,
            "run-on-projects": ["mozilla-central"],
            "treeherder": {"tier": 2},
            "optimization": {"skip-unless-expanded": None},
        }
        for name in names
    ]
    tasks = {
        task["name"]: task
        for task in run_transform(
            apply_enterprise_overrides, tasks, kind="build", path=BUILD_KIND_PATH
        )
    }

    linux = tasks["linux64-enterprise/opt"]
    assert linux["run-on-projects"] == ["mozilla-central", "enterprise-firefox"]
    assert linux["treeherder"]["tier"] == 1
    assert linux["worker"]["env"]["MOZ_AUTOMATION_PACKAGE_TESTS"] == "1"
    assert "MOZ_AUTOMATION_PACKAGE_TESTS" not in tasks[
        "linux64-aarch64-enterprise/opt"
    ].get("worker", {}).get("env", {})
    assert "optimization" not in tasks["win64-aarch64-enterprise/opt"]


if __name__ == "__main__":
    main()
