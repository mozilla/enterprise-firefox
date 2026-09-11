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

The push task additionally gets the OCI registry to publish to: its kind
defaults ``REGISTRY_REFERENCE`` to the dev registry, and everywhere but the try
and pull-request projects that default is replaced with the
``registry_reference`` its partner declares in repack.cfg. The credentials
secret follows from whichever reference the task ended up with. Ship needs no
such lookup: it reads the reference back from the push task's
``release-index.json``.
"""

from urllib.parse import urlparse

from taskgraph.transforms.base import TransformSequence
from taskgraph.util.dependencies import get_primary_dependency

from gecko_taskgraph.transforms.task import get_project_alias

transforms = TransformSequence()

PUSH_KIND = "enterprise-release-push"

# Which ``release_partner_config`` view to read repack.cfg entries that are not
# platform-specific from. Every kind's view holds the same partners, sub
# configs and repack.cfg values; they differ only in the platform list each
# kind kept (see ``partners._select_platforms``).
PARTNER_CONFIG_KIND = "enterprise-repack-repackage"

# Projects that must never publish to a partner's own registry, and so keep the
# staging REGISTRY_REFERENCE their kind defaults to. Matched against
# ``get_project_alias``, which is what appends the ``-pr`` suffix on pull
# requests.
STAGING_PROJECTS = {
    "enterprise-firefox-pr",
    "enterprise-firefox-try",
}

# Where a registry keeps its credentials. ``{name}`` is the repository part of
# the reference with its slashes flattened, so
# ``harbor.example.net/enterprise-shipit-dev/firefox`` is served by
# ``project/enterprise/level-3/oci-registry/enterprise-shipit-dev_firefox``.
# The push kind spells the same path in its ``secrets:get:`` scope.
SECRET_PATH = "project/enterprise/level-{level}/oci-registry/{name}"


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


@transforms.add
def set_registry_reference(config, tasks):
    """Replace the dev ``REGISTRY_REFERENCE`` with the partner's own.

    The kind defaults it to the dev registry, so try and pull-request graphs
    are left as they are and a test push can never reach a partner registry.
    Everywhere else it becomes the ``registry_reference`` the partner declares
    in repack.cfg, stored there as an https url (see ``partners.parse_config``)
    and reduced here to the bare ``registry/repo`` reference ``moa push
    release`` takes.
    """
    if config.kind != PUSH_KIND or get_project_alias(config) in STAGING_PROJECTS:
        yield from tasks
        return

    partner_configs = (config.params.get("release_partner_config") or {}).get(
        PARTNER_CONFIG_KIND, {}
    )
    for task in tasks:
        partner = task["attributes"]["partner"]
        sub_config = task["attributes"]["sub_config"]
        registry = (
            partner_configs
            .get(partner, {})
            .get(sub_config, {})
            .get("registry_reference")
        )
        if not registry:
            raise Exception(
                f"Partner repack '{partner}/{sub_config}' declares no "
                "registry_reference in its repack.cfg: there is no registry to "
                "push its enterprise release to."
            )

        url = urlparse(registry)
        repository = url.path.strip("/")
        if not repository:
            raise Exception(
                f"The registry_reference of partner repack "
                f"'{partner}/{sub_config}' names no repository: {registry!r}."
            )

        env = task.setdefault("worker", {}).setdefault("env", {})
        env["REGISTRY_REFERENCE"] = f"{url.netloc}/{repository}"
        yield task


@transforms.add
def set_registry_secret(config, tasks):
    """Derive ``REGISTRY_SECRET`` from the reference the task ended up with.

    A registry keeps its credentials in a secret named after the repository it
    serves, so the secret follows ``REGISTRY_REFERENCE`` -- the kind's dev
    default or the partner's own, indifferently. The kind spells the same
    ``SECRET_PATH`` in its ``secrets:get:`` scope; ``{name}`` is rendered here
    because only the transform knows the reference, and ``{level}`` along with
    it because the task transform expands that in scopes but not in env.
    """
    for task in tasks:
        env = task.get("worker", {}).get("env", {})
        reference = env.get("REGISTRY_REFERENCE")
        if not reference:
            yield task
            continue

        substitutions = {
            "level": config.params["level"],
            "name": reference.partition("/")[2].replace("/", "_"),
        }
        env["REGISTRY_SECRET"] = SECRET_PATH.format(**substitutions)
        task["scopes"] = [
            scope.format(**substitutions) if "{name}" in scope else scope
            for scope in task.get("scopes", [])
        ]
        yield task
