# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import pytest
from mozunit import main

from gecko_taskgraph.test.conftest import FakeParameters, FakeTransformConfig
from gecko_taskgraph.transforms import job  # noqa: F401
from gecko_taskgraph.transforms.task import TREEHERDER_ROOT_URL, get_treeherder_link


@pytest.mark.parametrize(
    "params,branch_map,expected_repo",
    [
        pytest.param(
            {
                "head_ref": "refs/heads/main",
                "head_rev": "abc123",
                "project": "test-project",
                "repository_type": "git",
                "tasks_for": "github-push",
            },
            {},
            "test-project",
            id="no_branch_map",
        ),
        pytest.param(
            {
                "head_ref": "refs/heads/main",
                "head_rev": "abc123",
                "project": "test-project",
                "repository_type": "git",
                "tasks_for": "github-push",
            },
            {"main": "firefox-main"},
            "firefox-main",
            id="branch_map_match",
        ),
        pytest.param(
            {
                "head_ref": "refs/heads/develop",
                "head_rev": "def456",
                "project": "test-project",
                "repository_type": "git",
                "tasks_for": "github-push",
            },
            {"main": "firefox-main"},
            "test-project",
            id="branch_map_no_match",
        ),
        pytest.param(
            {
                "head_ref": "refs/heads/main",
                "head_rev": "def456",
                "project": "test-project",
                "repository_type": "git",
                "tasks_for": "github-push",
            },
            {
                "by-project": {
                    "test-project": {"main": "firefox-main"},
                    "default": {},
                },
            },
            "firefox-main",
            id="by-project-match",
        ),
        pytest.param(
            {
                "head_ref": "refs/heads/develop",
                "head_rev": "def456",
                "project": "test-project",
                "repository_type": "git",
                "tasks_for": "github-push",
            },
            {
                "by-project": {
                    "test-project": {"main": "firefox-main"},
                    "default": {},
                },
            },
            "test-project",
            id="by-project-no-match",
        ),
        pytest.param(
            {
                "head_ref": "",
                "head_rev": "ghi789",
                "project": "test-project",
                "repository_type": "hg",
                "tasks_for": "hg-push",
            },
            {"main": "firefox-main"},
            "test-project",
            id="empty_head_ref",
        ),
        pytest.param(
            {
                "head_ref": "refs/heads/release",
                "head_rev": "jkl012",
                "project": "test-project",
                "repository_type": "git",
                "tasks_for": "github-pull-request",
            },
            {"release": "mozilla-release"},
            "test-project-pr",
            id="pull_request",
        ),
    ],
)
def test_get_treeherder_link(params, branch_map, expected_repo):
    graph_config = {
        "project-repo-param-prefix": "",
        "treeherder": {"group-names": {}},
    }
    if branch_map:
        graph_config["treeherder"]["branch-map"] = branch_map

    config = FakeTransformConfig(
        params=FakeParameters(params),
        graph_config=graph_config,
    )

    link = get_treeherder_link(config)
    expected_link = f"{TREEHERDER_ROOT_URL}/#/jobs?repo={expected_repo}&revision={params['head_rev']}&selectedTaskRun=<self>"
    assert link == expected_link


if __name__ == "__main__":
    main()
