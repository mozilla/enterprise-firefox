# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Offer the Thunderbird graph's actions on the Firefox Enterprise decision task.

A push to an enterprise repository builds two graphs from one checkout: this
one, and a Thunderbird one, produced by a second decision task that
``.taskcluster.yml`` runs with ``--root=comm/taskcluster``. That second
decision advertises its actions under a hook named after the hash of the
``.taskcluster.yml`` of the *comm* checkout, which is a hash no project in
``fxci-config`` declares under the enterprise trust domain -- so none of its
actions can be triggered, and the Thunderbird graph has no release promotion,
no retrigger, nothing.

The actions registered here work around that from the side that does have a
hook. They are ordinary actions of *this* decision task, so they ride the hook
already registered for this repository; what makes them Thunderbird actions is
the ``comm_graph`` they carry in their ``hookPayload``. ``.taskcluster.yml``
reads it back when it renders the action task and, rather than acting on this
graph, checks comm out at the revision the Thunderbird decision used, points
``ACTION_TASK_GROUP_ID`` at that decision task -- which is where ``mach
taskgraph action-callback`` fetches ``parameters.yml`` from -- and runs the
callback with ``--root=comm/taskcluster``.

The callback needs no special handling: action callbacks are always loaded
from this package whatever taskgraph root is in use, so the forwarded run
resolves the same functions, with Thunderbird's parameters and graph config.
"""

from gecko_taskgraph.actions.registry import register_callback_action
from gecko_taskgraph.actions.release_promotion import release_promotion_action


def is_comm_graph_available(parameters):
    """Whether this push also built a Thunderbird graph to act on."""
    return bool(parameters.get("comm_graph"))


def comm_hook_params(parameters):
    """Tell ``.taskcluster.yml`` to run this action against the comm graph."""
    return {"comm_graph": parameters["comm_graph"]}


@register_callback_action(
    name="release-promotion-comm",
    title="Thunderbird Release Promotion",
    symbol="${input.release_promotion_flavor}",
    description=(
        "Promote the Thunderbird release built by this push. Runs against the "
        "Thunderbird decision task's graph, not this one."
    ),
    permission="release-promotion",
    order=500,
    context=[],
    available=is_comm_graph_available,
    cb_name="comm-release-promotion",
    extra_hook_params=comm_hook_params,
    schema={
        "type": "object",
        "properties": {
            "release_promotion_flavor": {
                "type": "string",
                "description": (
                    "The flavor of release promotion to perform, as named in "
                    "`comm/taskcluster/config.yml`. Not enumerated here: this "
                    "decision task has no comm checkout to read them from."
                ),
            },
            "build_number": {
                "type": "integer",
                "default": 1,
                "minimum": 1,
                "title": "The release build number",
                "description": (
                    "The release build number. Starts at 1 per release "
                    "version, and increments on rebuild."
                ),
            },
            "previous_graph_ids": {
                "type": "array",
                "description": (
                    "An array of taskIds of the Thunderbird decision or action "
                    "tasks to reuse tasks from. Leave this out and the phase "
                    "before this one is rebuilt from scratch rather than "
                    "reused."
                ),
                "items": {"type": "string"},
            },
            "rebuild_kinds": {
                "type": "array",
                "description": (
                    "Optional: an array of kinds to ignore from the previous graph(s)."
                ),
                "items": {"type": "string"},
            },
            "do_not_optimize": {
                "type": "array",
                "description": (
                    "Optional: a list of labels to avoid optimizing out of the graph."
                ),
                "items": {"type": "string"},
            },
            "version": {
                "type": "string",
                "description": (
                    "Optional: override the in-tree version for release promotion."
                ),
                "default": "",
            },
            "next_version": {
                "type": "string",
                "description": "Next version.",
                "default": "",
            },
            "release_eta": {
                "type": "string",
                "default": "",
            },
        },
        "required": ["release_promotion_flavor", "build_number"],
    },
)
def comm_release_promotion_action(
    parameters, graph_config, input, task_group_id, task_id
):
    # By the time this runs, `.taskcluster.yml` has pointed the action task at
    # the Thunderbird graph: `parameters` are the Thunderbird decision's,
    # `graph_config` is `comm/taskcluster`'s, and `task_group_id` is the
    # Thunderbird decision task. Nothing is left to forward.
    return release_promotion_action(
        parameters, graph_config, input, task_group_id, task_id
    )
