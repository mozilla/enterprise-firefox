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

    for task in tasks:
        task.setdefault("scopes", []).append(
            f"hooks:trigger-hook:project-{trust_domain}/{hook}/*"
        )
        yield task
