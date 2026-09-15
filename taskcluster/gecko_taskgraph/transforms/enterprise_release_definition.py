# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Build the Mozilla OCI release definition (the JSON consumed by ``moa push
release``) directly inside a promote-phase task, one task per partner repack.

This replaces the index-scraping logic that used to live in ``moa generate
release`` (``mozilla-oci-artifacts-cli/src/taskcluster/generate.rs``). Inside
the task graph we already know everything that tool reconstructed at runtime:

* the upstream MAR/installer tasks are direct ``from_deps`` dependencies, so
  their task IDs are resolved via ``{"task-reference": "<label>"}`` instead of
  ``index.findTask``, and the artifact paths are the ones they advertise in
  ``artifact_prefix``/``release_artifacts`` instead of being reconstructed;
* build metadata (revision, build id, version, channel) comes from the decision
  parameters instead of scraping a build task's ``payload.env``;
* the policies schema/strings live in-tree at the build revision.

Most enterprise artifacts are specific to a partner repack, identified by a
``repack_id`` of the form ``{partner}/{sub_config}/{locale}``, which each kind
happens to expose in a different place -- see ``_repack_ids``. The rest
(``mar-signing``) are per build platform and shared across every repack of that
platform. We group all artifacts by repack id, emitting one release definition
per ``(partner, sub_config)`` with one variant per ``(build_target, locale)``.

A build target is only present if some per-repack artifact backs it, so the
definition degrades rather than breaking when a platform is missing from the
graph: notarization is level-3 only (see ``filter_notarization``), so a level-1
staging promotion yields definitions without the macOS variants.

If the graph contains no partner repacks (e.g. a non-promotion graph), no tasks
are emitted. The resulting definition is embedded into the task's
``RELEASE_DEFINITION`` env var as a single ``task-reference`` string; the
``<label>`` tokens it contains are substituted for the concrete dependency task
IDs when the task definition is finalized. The task body just writes that env
var out as an artifact.

Blobs are plain queue URLs through the taskcluster proxy, so whatever reads the
definition downloads them with an ordinary HTTP client and no Taskcluster
credentials of its own. That only works inside a task with
``taskcluster-proxy: true`` and the ``queue:get-artifact:`` scopes covering the
enterprise repacks, which the push task carries.
"""

import copy
import datetime
import json
import os

from taskgraph.transforms.base import TransformSequence
from taskgraph.util.dependencies import get_dependencies
from taskgraph.util.taskcluster import get_artifact_path

from gecko_taskgraph import GECKO
from gecko_taskgraph.parameters import get_release_type

transforms = TransformSequence()

# Maps an upstream task's ``build_platform`` attribute to the moa
# ``build_target`` identifier. Doubles as the allow-list of enterprise
# platforms: dependencies on any other platform are ignored.
BUILD_TARGETS = {
    "win64-enterprise-shippable": "WINNT_x86_64-msvc",
    "linux64-enterprise-shippable": "Linux_x86_64-gcc3",
    "linux64-aarch64-enterprise-shippable": "Linux_aarch64-gcc3",
    "macosx64-enterprise-shippable": "Darwin_aarch64-gcc3",
}

# Maps a dependency kind to the ``type`` of the release-definition blob it
# provides and a function building, from the repack components, the artifact
# path relative to the dependency's own ``artifact_prefix``. The resulting name
# is looked up in the dependency's ``release_artifacts``, so where each kind
# publishes is never spelled out here.
BLOB_SPECS = {
    "mar-signing": (
        "complete_mar",
        lambda partner, sub_config, locale: (
            "target.complete.mar"
            if locale == "en-US"
            else f"{locale}/target.complete.mar"
        ),
    ),
    "repackage-signing-msi": (
        "windows_msi",
        lambda partner, sub_config, locale: "target.installer.msi",
    ),
    "repackage-deb": (
        "linux_deb",
        lambda partner, sub_config, locale: "target.deb",
    ),
    "enterprise-repack-mac-notarization": (
        "macos_pkg",
        lambda partner, sub_config, locale: (
            f"{partner}/{sub_config}/{locale}/target.pkg"
        ),
    ),
}

# How a blob addresses its artifact: through the taskcluster proxy, which
# authenticates with the reading task's own scopes and redirects to wherever
# the queue stores the artifact -- so the client fetching it needs no
# credentials, but must follow redirects. ``http://taskcluster`` is where
# docker-worker exposes the proxy (its ``TASKCLUSTER_PROXY_URL``).
# ``<label>`` is replaced with the dependency's task id by ``task-reference``
# substitution.
ARTIFACT_URL = "http://taskcluster/queue/v1/task/<{label}>/artifacts/{path}"

# Kinds whose tasks are per build platform rather than per partner repack:
# their artifacts are shared by every repack of that platform. Tasks of any
# other kind that carry no repack id are not enterprise repacks at all (the
# plain per-locale MSIs, say) and are ignored.
SHARED_KINDS = {"mar-signing"}


@transforms.add
def make_release_definitions(config, tasks):
    for task in tasks:
        release_config = task.pop("release-config")
        build_assets = task.pop("build-assets")
        releases = _collect_releases(get_dependencies(config, task))

        if not releases and config.params["release_enable_enterprise_repack"]:
            raise Exception(
                "No enterprise release definition could be built: none of the "
                f"{sorted(BLOB_SPECS)} dependencies yielded a repack id. Without "
                "this check the kind would silently emit no tasks at all."
            )

        for (partner, sub_config), (variants, labels) in sorted(releases.items()):
            name = f"{partner}-{sub_config}"
            new_task = copy.deepcopy(task)
            new_task["name"] = name
            new_task["dependencies"] = {label: label for label in sorted(labels)}
            # Carried to the push/ship tasks (via from_deps) to derive the
            # registry reference from the partner config.
            new_task.setdefault("attributes", {}).update({
                "partner": partner,
                "sub_config": sub_config,
            })
            new_task["description"] = (
                f"Generate the Firefox Enterprise OCI release definition for "
                f"partner repack '{partner}/{sub_config}'."
            )
            new_task.setdefault("treeherder", {})["symbol"] = f"Ent({name})"

            definition = _build_definition(
                config, release_config, build_assets, variants
            )
            worker = new_task.setdefault("worker", {})
            worker.setdefault("env", {})["RELEASE_DEFINITION"] = {
                "task-reference": json.dumps(definition, separators=(",", ":"))
            }
            yield new_task


def _repack_ids(dep):
    """The repack ids (``partner/sub_config/locale``) a dependency contributes.

    Kinds fanned out per repack each expose their id somewhere different, so
    all three shapes have to be probed:

    * ``extra.repack_ids``: the chunked macOS signing/notarization tasks, which
      may cover several repacks each;
    * ``extra.repack_id``: the partner repackage tasks;
    * ``extra.treeherder.symbol``: the ``repackage-{deb,msi}`` chain, which
      keeps the id nowhere else -- ``repackage_signing`` itself recovers it from
      the symbol the same way.

    The last one only exists because ``repackage.py`` never carries the id it
    already reads out of its dependency any further. Doing so upstream would
    collapse this back into a single lookup.
    """
    extra = dep.task.get("extra", {})
    if extra.get("repack_ids"):
        return list(extra["repack_ids"])
    if extra.get("repack_id"):
        return [extra["repack_id"]]

    symbol = extra.get("treeherder", {}).get("symbol", "")
    if symbol.count("/") == 2:
        return [symbol]

    return []


def _artifact_path(dep, relpath):
    """``relpath`` as ``dep`` publishes it, or ``None`` if it does not.

    ``release_artifacts`` is the list of artifacts a task promises to the
    release pipeline, spelled exactly as the queue serves them, so it settles
    both where a kind publishes -- the enterprise repack prefix, the per-repack
    subdirectories of the chunked mac notarization tasks -- and whether the
    artifact exists at all.
    """
    path = get_artifact_path(dep, relpath)
    if path in dep.attributes.get("release_artifacts", []):
        return path
    return None


def _collect_releases(deps):
    """Group dependency artifacts into releases keyed by ``(partner, sub_config)``.

    Returns ``{(partner, sub_config): (variants, labels)}`` where ``variants``
    maps ``(build_target, locale) -> {blob_type: artifact url}`` and
    ``labels`` is the set of dependency labels the release references. Keying
    by blob type keeps one artifact per type per variant; the definition itself
    wants a list, which ``_build_definition`` flattens it into. The ``<label>``
    tokens in the URLs are resolved to task IDs later via ``task-reference``
    substitution.

    Dependencies of a ``SHARED_KINDS`` kind (``mar-signing``, which is per
    build platform and holds every locale) cannot establish a repack of their
    own, so they are held back and then attached to whichever variants the
    per-repack dependencies established for the same build target. A variant
    therefore only exists if some per-repack artifact backs it, and never
    consists of a MAR alone.

    A blob is only emitted for an artifact the dependency lists in
    ``release_artifacts``, so a locale the shared MAR signing task does not
    cover simply has no MAR rather than a URL to a file nobody published.
    """
    releases = {}
    shared = []

    for dep in deps:
        build_target = BUILD_TARGETS.get(dep.attributes.get("build_platform"))
        spec = BLOB_SPECS.get(dep.kind)
        if build_target is None or spec is None:
            continue

        if dep.kind in SHARED_KINDS:
            shared.append((build_target, dep, spec))
            continue

        blob_type, relpath_for = spec
        for repack_id in _repack_ids(dep):
            partner, sub_config, locale = repack_id.split("/")
            path = _artifact_path(dep, relpath_for(partner, sub_config, locale))
            if path is None:
                continue
            variants, labels = releases.setdefault((partner, sub_config), ({}, set()))
            variants.setdefault((build_target, locale), {})[blob_type] = (
                ARTIFACT_URL.format(label=dep.label, path=path)
            )
            labels.add(dep.label)

    for (partner, sub_config), (variants, labels) in releases.items():
        for shared_target, dep, (blob_type, relpath_for) in shared:
            for build_target, locale in variants:
                if build_target != shared_target:
                    continue
                path = _artifact_path(dep, relpath_for(partner, sub_config, locale))
                if path is None:
                    continue
                variants[(build_target, locale)][blob_type] = ARTIFACT_URL.format(
                    label=dep.label, path=path
                )
                labels.add(dep.label)

    return releases


def _build_definition(config, release_config, build_assets, variants):
    params = config.params
    revision = params["head_rev"]
    source = params["head_repository"]
    build_id = str(params["moz_build_date"])
    raw_base = source.replace(
        "https://github.com/", "https://raw.githubusercontent.com/"
    )

    variant_list = [
        {
            "locale": locale,
            "build_target": build_target,
            # A list of typed blobs, not a mapping of type to url: that is the
            # shape ``moa`` deserializes.
            "blobs": [
                {"file": url, "type": blob_type} for blob_type, url in blobs.items()
            ],
        }
        for (build_target, locale), blobs in sorted(variants.items())
    ]

    definition = {
        "product": release_config["product"],
        "version": params["version"],
        "build_id": build_id,
        "channel": get_release_type(params) or "nightly-enterprise",
        "vendor": release_config["vendor"],
        "revision": revision,
        "source": source,
        "license": release_config["license"],
        "variants": variant_list,
        "policies": _build_policies(raw_base, revision, build_assets),
    }

    created_at = _build_date_to_rfc3339(build_id)
    if created_at:
        definition["created_at"] = created_at

    for key in ("title", "description"):
        if release_config.get(key):
            definition[key] = release_config[key]
    if release_config.get("documentation-url"):
        definition["documentation_url"] = release_config["documentation-url"]

    return definition


def _build_policies(raw_base, revision, build_assets):
    ftl_files = {
        "en-US": f"{raw_base}/{revision}/{build_assets['policies-ftl-source']}",
    }

    changesets_path = os.path.join(GECKO, build_assets["enterprise-l10n"])
    try:
        with open(changesets_path) as fh:
            changesets = json.load(fh)
    except FileNotFoundError:
        changesets = {}

    for locale, info in changesets.items():
        l10n_rev = info.get("revision")
        if not l10n_rev:
            continue
        ftl_files[locale] = (
            f"{build_assets['l10n-repo']}/{l10n_rev}/{locale}/{build_assets['policies-ftl-l10n']}"
        )

    return {
        "policies_schema": f"{raw_base}/{revision}/{build_assets['policies-schema']}",
        "ftl_files": ftl_files,
    }


def _build_date_to_rfc3339(build_id):
    """Convert a ``YYYYMMDDHHMMSS`` build id into an RFC 3339 timestamp."""
    try:
        parsed = datetime.datetime.strptime(build_id, "%Y%m%d%H%M%S")
    except ValueError:
        return None
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ")
