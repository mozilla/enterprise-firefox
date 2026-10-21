# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from taskgraph.transforms.base import TransformSequence

transforms = TransformSequence()


@transforms.add
def add_hook_scope(config, tasks):
    params = config.params
    if not params.get("comm_checkout"):
        return

    trust_domain = config.graph_config["trust-domain"]
    level = params["level"]
    if params["tasks_for"].startswith("github-pull-request"):
        hook = f"in-tree-pr-action-{level}-comm-decision"
    else:
        hook = f"in-tree-action-{level}-comm-decision"

    # WIP - HACK FOR TRY: no decision role can grant the hook scope yet, so
    # trigger the action from Treeherder instead.
    del hook
    checkout = params["comm_checkout"]
    for task in tasks:
        # Read by the Enterprise Thunderbird decision for its partner config.
        task.setdefault("scopes", []).append(
            f"secrets:get:project/{trust_domain}/level-{level}/partner-github-api"
        )
        task["worker"]["env"].update({
            "DCT_COMM_REPOSITORY": checkout["head_repository"],
            "DCT_COMM_REV": checkout["head_rev"],
        })
        yield task
