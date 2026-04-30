# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from taskgraph.transforms.base import TransformSequence

transforms = TransformSequence()


@transforms.add
def add_dependencies(config, jobs):
    for job in jobs:
        job.setdefault("dependencies", {})
        job["dependencies"] = {
            dep_task.kind: label
            for (label, dep_task) in config.kind_dependencies_tasks.items()
        }
        yield job
