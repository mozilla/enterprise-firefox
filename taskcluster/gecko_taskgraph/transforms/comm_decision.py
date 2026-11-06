# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Create the decision task of the Thunderbird (comm) graph, see
gecko_taskgraph/util/comm_decision.py.
"""

import os

from taskgraph.transforms.base import TransformSequence

from gecko_taskgraph.util.comm_decision import (
    COMM_DECISION_LABEL,
    COMM_PROJECTS,
    get_comm_decision_treeherder,
    make_comm_decision_task,
)

transforms = TransformSequence()

# The comm graph is only generated for pushes, like the Gecko graph of
# `enterprise-firefox` pull requests is restricted to linting.
COMM_TASKS_FOR = ("github-push",)


@transforms.add
def filter_projects(config, tasks):
    if (
        config.params["project"] not in COMM_PROJECTS
        or config.params["tasks_for"] not in COMM_TASKS_FOR
    ):
        return
    yield from tasks


@transforms.add
def make_task(config, tasks):
    for task in tasks:
        attributes = task.get("attributes", {})
        if "TASK_ID" not in os.environ:
            # Outside of a decision task (`mach taskgraph`, `mach try`) there is
            # no task to copy: only provide the label, so that it can be
            # selected.
            yield {
                "label": COMM_DECISION_LABEL,
                "description": task["description"],
                "attributes": attributes,
                "dependencies": {},
                "optimization": None,
                "task": {
                    "provisionerId": "{}-{}".format(
                        config.graph_config["trust-domain"], config.params["level"]
                    ),
                    "workerType": "decision",
                    "metadata": {
                        "name": COMM_DECISION_LABEL,
                        "description": task["description"],
                    },
                    "payload": {},
                    "extra": {"treeherder": get_comm_decision_treeherder()},
                },
            }
            continue

        taskdesc = make_comm_decision_task(config.graph_config, config.params)
        taskdesc["attributes"].update(attributes)
        yield taskdesc
