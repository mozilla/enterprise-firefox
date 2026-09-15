# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Drop tasks whose ``from-deps`` selection matches nothing. ``from_deps`` raises
on an empty ``group-by: all`` group, which happens once the upstream kinds are
disabled by a parameter.
"""

from taskgraph.transforms.base import TransformSequence
from taskgraph.util.attributes import attrmatch

transforms = TransformSequence()


@transforms.add
def require_deps(config, tasks):
    kind_deps = config.config.get("kind-dependencies", [])
    for task in tasks:
        from_deps = task.get("from-deps", {})
        kinds = from_deps.get("kinds", kind_deps)
        with_attributes = from_deps.get("with-attributes")
        if any(
            dep.kind in kinds
            and (not with_attributes or attrmatch(dep.attributes, **with_attributes))
            for dep in config.kind_dependencies_tasks.values()
        ):
            yield task
