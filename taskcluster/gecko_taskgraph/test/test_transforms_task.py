# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import pytest
from mozunit import main
from taskgraph.config import GraphConfig

from gecko_taskgraph.test.conftest import FakeParameters, FakeTransformConfig
from gecko_taskgraph.transforms import job  # noqa: F401
from gecko_taskgraph.transforms.task import (
    TREEHERDER_ROOT_URL,
    get_default_priority,
    get_treeherder_link,
    get_treeherder_project,
    is_shared_worker,
    try_task_config_env,
)


@pytest.mark.parametrize(
    "params,branch_map,expected_project",
    [
        pytest.param(
            {
                "head_ref": "refs/heads/main",
                "base_repository": "https://github.com/mozilla/test-project",
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
                "base_repository": "https://github.com/mozilla/test-project",
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
                "base_repository": "https://github.com/mozilla/test-project",
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
                "base_repository": "https://github.com/mozilla/test-project",
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
                "base_repository": "https://github.com/mozilla/test-project",
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
                "base_repository": "https://hg.mozilla.org/test-project",
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
                "base_repository": "https://github.com/mozilla/test-project",
                "project": "test-project",
                "repository_type": "git",
                "tasks_for": "github-pull-request",
            },
            {"release": "mozilla-release"},
            "test-project-pr",
            id="pull_request",
        ),
        pytest.param(
            {
                "head_ref": "refs/heads/test-branch",
                "base_repository": "https://github.com/mozilla/test-project",
                "project": "test-project",
                "repository_type": "git",
                "tasks_for": "github-push",
            },
            {"test-.*": "foo", "default": "bar"},
            "foo",
            id="regex",
        ),
        pytest.param(
            {
                "head_ref": "refs/heads/release",
                "base_repository": "https://github.com/mozilla/test-project",
                "project": "test-project",
                "repository_type": "git",
                "tasks_for": "github-push",
            },
            {"test-.*": "foo", "default": "bar"},
            "bar",
            id="regex-default",
        ),
        pytest.param(
            {
                "base_repository": "https://github.com/mozilla/enterprise-firefox",
                "head_ref": "refs/heads/enterprise-main",
                "project": "enterprise-thunderbird",
                "repository_type": "git",
                "tasks_for": "github-push",
            },
            {},
            "enterprise-firefox",
            id="triggered_from_other_project",
        ),
    ],
)
def test_get_treeherder_project(params, branch_map, expected_project):
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

    project = get_treeherder_project(config)
    assert project == expected_project


def test_get_treeherder_link():
    branch = "main"
    repo = "firefox-main"
    graph_config = {
        "project-repo-param-prefix": "",
        "treeherder": {"group-names": {}, "branch-map": {branch: repo}},
    }

    params = {
        "head_ref": f"refs/heads/{branch}",
        "head_rev": "def456",
        "project": "test-project",
        "repository_type": "git",
        "tasks_for": "github-push",
    }
    config = FakeTransformConfig(
        params=FakeParameters(params),
        graph_config=graph_config,
    )

    link = get_treeherder_link(config)
    expected_link = f"{TREEHERDER_ROOT_URL}/#/jobs?repo={repo}&revision={params['head_rev']}&selectedTaskRun=<self>"
    assert link == expected_link


@pytest.mark.parametrize(
    "implementation",
    ("docker-worker", "generic-worker"),
)
def test_try_task_config_env_applies(run_transform, implementation):
    """Env vars from try_task_config are applied to workers that have an env field.

    This covers both voluptuous (LegacySchema) and msgspec Struct payload
    builder schemas, since docker-worker and generic-worker were converted to
    msgspec in the upstream taskgraph library.
    """
    task = {
        "worker": {
            "implementation": implementation,
            "env": {"EXISTING": "value"},
        }
    }
    params = FakeParameters({"try_task_config": {"env": {"NEW_VAR": "new_value"}}})
    result = list(run_transform(try_task_config_env, task, params=params))[0]
    assert result["worker"]["env"] == {"EXISTING": "value", "NEW_VAR": "new_value"}


def test_try_task_config_env_skips_no_env_impl(run_transform):
    """Env vars are not applied to implementations without an env field."""
    task = {
        "worker": {
            "implementation": "bouncer-aliases",
        }
    }
    params = FakeParameters({"try_task_config": {"env": {"NEW_VAR": "new_value"}}})
    result = list(run_transform(try_task_config_env, task, params=params))[0]
    assert "env" not in result["worker"]


def test_try_task_config_env_no_env_config(run_transform):
    """Transform is a no-op when try_task_config has no env key."""
    task = {
        "worker": {
            "implementation": "docker-worker",
            "env": {"EXISTING": "value"},
        }
    }
    params = FakeParameters({"try_task_config": {}})
    result = list(run_transform(try_task_config_env, task, params=params))[0]
    assert result["worker"]["env"] == {"EXISTING": "value"}


def _test_paths_task(**attributes):
    return {
        "attributes": attributes,
        "worker": {
            "implementation": "docker-worker",
            "env": {"MOZHARNESS_TEST_PATHS": '{"suite": ["dir/manifest.toml"]}'},
        },
    }


def test_try_task_config_env_keeps_restricted_test_paths(run_transform):
    """A task whose manifests were restricted to what try asked for keeps the
    share of the request that its own chunk runs."""
    task = _test_paths_task(**{"test-manifests-restricted": True})
    params = FakeParameters({
        "try_task_config": {"env": {"MOZHARNESS_TEST_PATHS": '{"suite": ["dir"]}'}}
    })

    result = list(run_transform(try_task_config_env, task, params=params))[0]

    assert result["worker"]["env"]["MOZHARNESS_TEST_PATHS"] == (
        '{"suite": ["dir/manifest.toml"]}'
    )


def test_try_task_config_env_overrides_unrestricted_test_paths(run_transform):
    """A task that kept the whole suite needs what try asked for, since the
    harness is what filters the suite down for it."""
    task = _test_paths_task()
    params = FakeParameters({
        "try_task_config": {"env": {"MOZHARNESS_TEST_PATHS": '{"suite": ["dir"]}'}}
    })

    result = list(run_transform(try_task_config_env, task, params=params))[0]

    assert result["worker"]["env"]["MOZHARNESS_TEST_PATHS"] == '{"suite": ["dir"]}'


TASK_PRIORITY_CONFIG = {
    "by-project": {
        "enterprise-(firefox|thunderbird)": {
            "by-shared-worker": {
                "true": {
                    "by-head-ref": {
                        "enterprise-release": "very-high",
                        "enterprise-beta": {
                            "by-shipping": {"true": "high", "default": "very-low"},
                        },
                        "enterprise-main": "low",
                        "default": "lowest",
                    },
                },
                "default": {
                    "by-head-ref": {
                        "enterprise-release": "highest",
                        "enterprise-beta": {
                            "by-shipping": {"true": "very-high", "default": "low"},
                        },
                        "enterprise-main": "medium",
                        "default": "very-low",
                    },
                },
            },
        },
        "enterprise-(firefox|thunderbird)-try": {
            "by-shared-worker": {"true": "lowest", "default": "very-low"},
        },
        "mozilla-release": "highest",
        "mozilla-esr.*": {
            "by-shipping": {"true": "very-high", "default": "low"},
        },
        "mozilla-beta": {
            "by-shipping": {"true": "very-high", "default": "low"},
        },
        "mozilla-central": "medium",
        "autoland": "low",
        "default": "very-low",
    }
}


@pytest.mark.parametrize(
    "project,head_ref,shared_worker,shipping,expected",
    [
        # Beta and ESR are integration branches by default, and are only
        # raised when the push is flagged as shipping.
        pytest.param("mozilla-beta", "", False, False, "low", id="beta"),
        pytest.param("mozilla-beta", "", False, True, "very-high", id="beta-shipping"),
        pytest.param("mozilla-esr140", "", False, False, "low", id="esr"),
        pytest.param("mozilla-esr140", "", False, True, "very-high", id="esr-shipping"),
        # Every other project ignores the shipping flag.
        pytest.param(
            "mozilla-release", "", False, True, "highest", id="release-shipping"
        ),
        pytest.param(
            "mozilla-central", "", False, True, "medium", id="central-shipping"
        ),
        pytest.param("autoland", "", False, True, "low", id="autoland-shipping"),
        pytest.param("try", "", False, True, "very-low", id="try-shipping"),
        pytest.param("mozilla-central", "", False, False, "medium", id="central"),
        pytest.param("autoland", "", False, False, "low", id="autoland"),
        pytest.param("try", "", False, False, "very-low", id="try"),
        # Enterprise keys off the branch rather than the project, mirroring
        # the mozilla-* priorities on the pools it owns.
        pytest.param(
            "enterprise-firefox",
            "enterprise-release",
            False,
            False,
            "highest",
            id="enterprise-release",
        ),
        pytest.param(
            "enterprise-firefox",
            "enterprise-beta",
            False,
            False,
            "low",
            id="enterprise-beta",
        ),
        pytest.param(
            "enterprise-firefox",
            "enterprise-beta",
            False,
            True,
            "very-high",
            id="enterprise-beta-shipping",
        ),
        pytest.param(
            "enterprise-firefox",
            "enterprise-main",
            False,
            True,
            "medium",
            id="enterprise-main",
        ),
        pytest.param(
            "enterprise-firefox",
            "some-branch",
            False,
            False,
            "very-low",
            id="enterprise-other-branch",
        ),
        pytest.param(
            "enterprise-firefox-try",
            "enterprise-main",
            False,
            False,
            "very-low",
            id="enterprise-try",
        ),
        # On pools shared with gecko, every tier drops one notch so that
        # Firefox tasks always win the queue.
        pytest.param(
            "enterprise-firefox",
            "enterprise-release",
            True,
            False,
            "very-high",
            id="enterprise-release-shared",
        ),
        pytest.param(
            "enterprise-firefox",
            "enterprise-beta",
            True,
            False,
            "very-low",
            id="enterprise-beta-shared",
        ),
        pytest.param(
            "enterprise-firefox",
            "enterprise-beta",
            True,
            True,
            "high",
            id="enterprise-beta-shipping-shared",
        ),
        pytest.param(
            "enterprise-firefox",
            "enterprise-main",
            True,
            True,
            "low",
            id="enterprise-main-shared",
        ),
        pytest.param(
            "enterprise-firefox",
            "some-branch",
            True,
            False,
            "lowest",
            id="enterprise-other-branch-shared",
        ),
        pytest.param(
            "enterprise-firefox-try",
            "enterprise-main",
            True,
            False,
            "lowest",
            id="enterprise-try-shared",
        ),
        # Thunderbird shares the Enterprise priorities.
        pytest.param(
            "enterprise-thunderbird",
            "enterprise-main",
            False,
            False,
            "medium",
            id="enterprise-thunderbird-main",
        ),
        pytest.param(
            "enterprise-thunderbird",
            "enterprise-main",
            True,
            False,
            "low",
            id="enterprise-thunderbird-main-shared",
        ),
    ],
)
def test_get_default_priority(project, head_ref, shared_worker, shipping, expected):
    # GraphConfig is hashable, which get_default_priority requires as it is cached.
    graph_config = GraphConfig({"task-priority": TASK_PRIORITY_CONFIG}, root_dir=".")
    assert (
        get_default_priority(graph_config, project, head_ref, shared_worker, shipping)
        == expected
    )


@pytest.mark.parametrize(
    "provisioner_id,worker_type,expected",
    [
        pytest.param("releng-hardware", "gecko-t-osx-1500-m4", True, id="osx-test"),
        pytest.param("releng-hardware", "gecko-3-b-osx-1015", True, id="osx-build"),
        pytest.param("releng-hardware", "gecko-t-linux-talos", True, id="talos"),
        pytest.param("releng-hardware", "win10-64-2009-hw", True, id="win-hardware"),
        pytest.param("proj-autophone", "gecko-t-bitbar-gw-unit-p2", True, id="bitbar"),
        pytest.param("enterprise-t", "t-osx-1500-m4", False, id="own-test"),
        pytest.param("enterprise-3", "b-linux-amd", False, id="own-build"),
        pytest.param(
            "releng-hardware", "enterprise-3-b-osx-arm64", False, id="own-osx-build"
        ),
        pytest.param(
            "scriptworker-k8s", "enterprise-3-signing", False, id="own-scriptworker"
        ),
    ],
)
def test_is_shared_worker(provisioner_id, worker_type, expected):
    graph_config = GraphConfig({"trust-domain": "enterprise"}, root_dir=".")
    assert is_shared_worker(graph_config, provisioner_id, worker_type) is expected


if __name__ == "__main__":
    main()
