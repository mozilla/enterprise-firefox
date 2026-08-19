# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from taskgraph.transforms.base import TransformSequence

transforms = TransformSequence()


@transforms.add
def convert_deps_to_if_deps(config, tasks):
    """
    If `convert-if-deps` is True, converts all dependencies to if-dependencies.
    """
    for task in tasks:
        if (deps := task.get("dependencies")) and task.pop("convert-if-deps", False):
            if_deps = set(task.setdefault("if-dependencies", set()))
            if_deps.update(deps.values())
            task["if-dependencies"] = if_deps

        yield task
