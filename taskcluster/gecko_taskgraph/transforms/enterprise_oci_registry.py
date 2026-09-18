# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Wire up each per-repack enterprise OCI registry task (upload and tag).

The registry reference is derived from the repack config
(``{partner}/{sub_config}``) a task's release belongs to. The upload task gets
it on its ``extra`` from ``enterprise_release_definition``, which runs just
before this transform; the tag task reads it from the upload task it depends
on. Each task also gets its own treeherder symbol and description, with the
verb (``upload``/``tag``) taken from the kind name.

The upload task also gets the registry to publish to. Its kind defaults
``REGISTRY_REFERENCE`` to the dev registry, and only a production release
replaces it with the ``registry_reference`` the partner declares in repack.cfg.
The credentials secret follows whichever reference the task ended up with.
Tagging needs no lookup: it reads the reference back from the upload task's
``release-index.json``.
"""

from urllib.parse import urlparse

from mozilla_taskgraph.util.attributes import release_level
from taskgraph.transforms.base import TransformSequence
from taskgraph.util.dependencies import get_primary_dependency

transforms = TransformSequence()

UPLOAD_KIND = "enterprise-oci-upload"


@transforms.add
def set_repack_metadata(config, tasks):
    """Name each task after the repack its release belongs to.

    ``enterprise_release_definition`` hands the upload kind its repack config.
    The tag kind takes it from the upload task it depends on and records it on
    itself, so later transforms can read it from ``extra`` either way.
    """
    # Kind names are `enterprise-oci-upload` / `enterprise-oci-tag`.
    verb = config.kind.rsplit("-", 1)[-1]
    for task in tasks:
        extra = task.setdefault("extra", {})
        if config.kind != UPLOAD_KIND:
            dep = get_primary_dependency(config, task)
            assert dep
            extra["repack_config"] = dep.task["extra"]["repack_config"]

        name = task["name"]
        task["description"] = (
            f"{verb.capitalize()} the Firefox Enterprise OCI release for "
            f"partner repack '{extra['repack_config']}'."
        )
        task.setdefault("treeherder", {})["symbol"] = f"Ent({verb}-{name})"
        yield task


@transforms.add
def set_registry_reference(config, tasks):
    """Replace the dev ``REGISTRY_REFERENCE`` with the partner's own.

    The kind defaults it to the dev registry and only a production release
    replaces that, so a test push can never reach a partner registry.
    ``release_level`` decides: level 3 on a branch the graph config's
    ``release-branches`` names for this project. Try, pull requests, level 1
    graphs and pushes to any other branch all keep the dev registry.

    For a production release the value becomes the ``registry_reference`` the
    partner declares in repack.cfg. It is stored there as an https url (see
    ``partners.parse_config``) and cut down here to the bare ``registry/repo``
    reference ``moa push release`` takes.
    """
    is_production = (
        release_level(config.graph_config["release-branches"], config.params)
        == "production"
    )
    if config.kind != UPLOAD_KIND or not is_production:
        yield from tasks
        return

    # Any kind's `release_partner_config` view will do for a repack.cfg entry
    # that is not platform-specific. They all hold the same partners, sub
    # configs and values, and differ only in the platform list each kind kept
    # (see `partners._select_platforms`).
    partner_configs = (config.params.get("release_partner_config") or {}).get(
        "enterprise-repack-repackage", {}
    )
    for task in tasks:
        partner, sub_config = task["extra"]["repack_config"].split("/")
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
    serves, so the secret follows ``REGISTRY_REFERENCE``, whether that is the
    kind's dev default or the partner's own. The path comes from the
    ``secrets:get:`` scope the kind declares, the only place it is written
    down. ``{name}`` is rendered here because only this transform knows the
    reference, and ``{level}`` with it because the task transform expands that
    in scopes but not in env.
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
        scopes, secrets = [], []
        for scope in task.get("scopes", []):
            if "{name}" in scope:
                scope = scope.format(**substitutions)
                if scope.startswith("secrets:"):
                    # `secrets:<action>:<name>`
                    secrets.append(scope.split(":", 2)[-1])
            scopes.append(scope)

        if len(secrets) != 1:
            raise Exception(
                f"{config.kind} must name the registry credentials it reads in "
                f"exactly one `secrets:` scope, found {secrets}."
            )

        task["scopes"] = scopes
        env["REGISTRY_SECRET"] = secrets[0]
        yield task
