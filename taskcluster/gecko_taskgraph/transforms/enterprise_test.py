# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
"""


import logging

from taskgraph.transforms.base import TransformSequence
from taskgraph.util.copy import deepcopy
from taskgraph.util.dependencies import get_primary_dependency
from taskgraph.util.schema import resolve_keyed_by
from taskgraph.util.treeherder import inherit_treeherder_from_dep

logger = logging.getLogger(__name__)

transforms = TransformSequence()


@transforms.add
def fill_template(config, tasks):
    for task in tasks:
        for platform in task["test-platforms"]:
            this_name = task["name"]
            if not platform in this_name:
                continue

            this_task = deepcopy(task)

            del this_task["test-platforms"]

            assert "enterprise" in this_task.get("name")

            if "linux" in platform:
                this_task["worker"]["docker-image"] = {}
                this_task["worker"]["docker-image"]["in-tree"] = "ubuntu2404-test"

            dep = get_primary_dependency(config, this_task)
            assert dep
            inherit_treeherder_from_dep(this_task, dep)

            test_slug = task.get("attributes")["enterprise_test_slug"]
            this_task["label"] = f"enterprise-test-{test_slug}-{this_name}"
            this_task["treeherder"]["symbol"] = f"Tent({test_slug})"

            resolve_keyed_by(
                item=this_task,
                field="worker-type",
                item_name=this_task["name"],
                **{"test-platform": platform},
            )

            resolve_keyed_by(
                item=this_task,
                field="worker.artifacts",
                item_name=this_task["name"],
                **{"test-platform": platform},
            )

            resolve_keyed_by(
                item=this_task,
                field="worker.env",
                item_name=this_task["name"],
                **{"test-platform": platform},
            )

            resolve_keyed_by(
                item=this_task,
                field="fetches.build",
                item_name=this_task["name"],
                **{"test-platform": platform},
            )

            resolve_keyed_by(
                item=this_task,
                field="fetches.toolchain",
                item_name=this_task["name"],
                **{"test-platform": platform},
            )

            resolve_keyed_by(
                item=this_task,
                field="run.command",
                item_name=this_task["name"],
                **{"test-platform": platform},
            )

            test_file = task.get("attributes")["enterprise_test_file"]
            this_task.get("run")["command"] = this_task.get("run")["command"].format(
                enterprise_test_file=test_file
            )

            chaos_task = deepcopy(this_task)
            existing_label = this_task["label"].split("/")
            chaos_task["label"] = f"{existing_label[0]}-chaos/{existing_label[1]}"
            chaos_task["treeherder"]["symbol"] = f"TentChaos({test_slug})"
            chaos_task["worker"]["env"].update({"MOZ_CHAOSMODE": "0xfb"})

            yield this_task
            yield chaos_task
