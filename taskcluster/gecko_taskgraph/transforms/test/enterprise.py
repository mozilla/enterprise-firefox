# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from taskgraph.transforms.base import TransformSequence

task_transforms = TransformSequence()


@task_transforms.add
def force_optimization(config, tasks):
    for task in tasks:
        task["optimization"] = {"never": None}
        yield task


@task_transforms.add
def force_test_manifests(config, tasks):
    for task in tasks:
        task["attributes"]["test_manifests"] = ["empty.toml"]
        yield task


@task_transforms.add
def add_scopes_and_proxy(config, tasks):
    for task in tasks:
        task.setdefault("worker", {})["taskcluster-proxy"] = True
        task.setdefault("scopes", []).append(
            "secrets:get:project/enterprise/level-{level}/enterprise-console-backend-apitoken"
        )
        yield task


@task_transforms.add
def add_upstream_tasks(config, tasks):
    for task in tasks:
        task["worker"].setdefault("env", {})["UPSTREAM_TASKIDS"] = {
            # We only want signing related tasks here, not build (used by mac builds for signing artifact resolution)
            "task-reference": " ".join([
                f"<{dep}>" for dep in task["dependencies"] if ("build" in dep)
            ])
        }
        yield task
