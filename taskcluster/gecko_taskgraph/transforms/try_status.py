# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Hand the branch of the current push to the try status generator.

The generator looks that branch up in the try repository at runtime, so the only
thing it needs from the decision task is where this push came from, and the right
to put the report tasks it creates on this push.
"""

from taskgraph.transforms.base import TransformSequence

from gecko_taskgraph.transforms.task import (
    TREEHERDER_ROUTE_ROOT,
    get_branch_rev,
    get_treeherder_project,
)

transforms = TransformSequence()


@transforms.add
def add_push_coordinates(config, jobs):
    # The decision task only holds the route of the push it is running for, so
    # the scope has to name that one route rather than the whole namespace. Built
    # the same way as the route itself, in gecko_taskgraph.transforms.task.
    route = f"{TREEHERDER_ROUTE_ROOT}.v2.{get_treeherder_project(config)}.{get_branch_rev(config)}"

    for job in jobs:
        env = job.setdefault("worker", {}).setdefault("env", {})
        env["TRY_STATUS_HEAD_REF"] = config.params["head_ref"] or ""
        # The commit the try push has to sit on for it to be this pull request.
        env["TRY_STATUS_HEAD_REV"] = config.params["head_rev"]
        env["TRY_STATUS_TRUST_DOMAIN"] = config.graph_config["trust-domain"]

        job.setdefault("scopes", []).append(f"queue:route:{route}")
        yield job
