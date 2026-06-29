# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from gecko_taskgraph.actions.registry import register_callback_action
from gecko_taskgraph.actions.release_promotion import release_promotion_action
from gecko_taskgraph.util.attributes import (
    ENTERPRISE_PRODUCTS,
    ENTERPRISE_PROMOTION_PROJECTS,
)


def is_enterprise_release_promotion_available(parameters):
    return parameters["project"] in ENTERPRISE_PROMOTION_PROJECTS


def get_enterprise_flavors(graph_config):
    return sorted(
        flavor
        for flavor, config in graph_config["release-promotion"]["flavors"].items()
        if config["product"] in ENTERPRISE_PRODUCTS
    )


def get_default_enterprise_flavor(graph_config):
    flavors = get_enterprise_flavors(graph_config)
    return flavors[0] if flavors else ""


# Same callback as `release-promotion`, restricted to the enterprise products.
# `permission` deliberately stays `release-promotion` so the existing
# in-tree-action hook and its role are reused.
register_callback_action(
    name="enterprise-release-promotion",
    title="Enterprise Release Promotion",
    symbol="${input.release_promotion_flavor}",
    description="Promote an enterprise release.",
    permission="release-promotion",
    order=500,
    context=[],
    available=is_enterprise_release_promotion_available,
    cb_name="enterprise-release-promotion",
    schema=lambda graph_config: {
        "type": "object",
        "properties": {
            "release_promotion_flavor": {
                "type": "string",
                "description": "The flavor of release promotion to perform.",
                "default": get_default_enterprise_flavor(graph_config),
                "enum": get_enterprise_flavors(graph_config),
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
            "revision": {
                "type": "string",
                "title": "Optional: revision to promote",
                "description": (
                    "Optional: the revision to promote. Defaults to the "
                    "revision this action was triggered from."
                ),
            },
            "previous_graph_ids": {
                "type": "array",
                "description": (
                    "Optional: an array of taskIds of decision or action tasks "
                    "from the previous graph(s) to reuse tasks from."
                ),
                "items": {"type": "string"},
            },
            "rebuild_kinds": {
                "type": "array",
                "description": (
                    "Optional: an array of kinds to ignore from the previous graph(s)."
                ),
                "default": graph_config["release-promotion"].get("rebuild-kinds", []),
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
            "release_eta": {
                "type": "string",
                "default": "",
            },
            "release_partner_config": {
                "type": "object",
                "description": (
                    "Optional: enterprise repack configuration. Looked up from "
                    "the manifest repository when omitted."
                ),
                "properties": {},
                "additionalProperties": True,
            },
        },
        "required": ["release_promotion_flavor", "build_number"],
    },
)(release_promotion_action)
