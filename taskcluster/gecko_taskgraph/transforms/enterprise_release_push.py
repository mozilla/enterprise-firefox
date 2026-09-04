# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Wire up each per-repack enterprise release registry task (push and ship).

The partner repack identity (``partner``/``sub_config``) is read from the
primary ``from_deps`` dependency -- the release-definition task for push, the
push task for ship -- and stamped onto the task so the registry reference can be
derived from the partner config. Each task also gets a unique treeherder symbol
and description; the phase verb (``push``/``ship``) comes from the kind name.
"""

from taskgraph.transforms.base import TransformSequence
from taskgraph.util.dependencies import get_primary_dependency

transforms = TransformSequence()


@transforms.add
def set_repack_metadata(config, tasks):
    # Kind names are `enterprise-release-push` / `enterprise-release-ship`.
    verb = config.kind.rsplit("-", 1)[-1]
    for task in tasks:
        dep = get_primary_dependency(config, task)
        partner = dep.attributes["partner"]
        sub_config = dep.attributes["sub_config"]
        task.setdefault("attributes", {}).update({
            "partner": partner,
            "sub_config": sub_config,
        })

        name = task["name"]
        task["description"] = (
            f"{verb.capitalize()} the Firefox Enterprise OCI release for "
            f"partner repack '{partner}/{sub_config}' to the registry."
        )
        task.setdefault("treeherder", {})["symbol"] = f"Ent({verb}-{name})"
        yield task
