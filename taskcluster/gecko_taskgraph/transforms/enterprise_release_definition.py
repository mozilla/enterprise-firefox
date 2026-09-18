# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Build the Mozilla OCI release definition (the JSON consumed by ``moa push
release``) for the OCI upload task itself, one task per partner repack.

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

Most enterprise artifacts belong to one partner repack, named by a repack
config of the form ``{partner}/{sub_config}`` and holding all of its locales
(see ``_repack``). The rest are per build platform and shared by every repack
of that platform. Artifacts are grouped by repack config, giving one release
definition per config with one variant per ``(build_target, locale)``.

A build target is only present if some per-repack artifact backs it, so the
definition degrades rather than breaking when a platform is missing from the
graph: notarization is level-3 only (see ``filter_notarization``), so a level-1
staging promotion yields definitions without the macOS variants.

If the graph contains no partner repacks (e.g. a non-promotion graph), no tasks
are emitted. The resulting definition is embedded into the task's
``RELEASE_DEFINITION`` env var as a single ``task-reference`` string; the
``<label>`` tokens it contains are replaced with the real dependency task IDs
when the task definition is finalized. That is why this has to run on a task
that depends on all of them, which is the upload task.

Blobs are plain queue URLs through the taskcluster proxy, so whatever reads the
definition downloads them with an ordinary HTTP client and no Taskcluster
credentials of its own. That only works inside a task with
``taskcluster-proxy: true`` and the ``queue:get-artifact:`` scopes covering the
enterprise repacks, both of which the upload task carries.
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
# ``build_target`` identifier, like ``partials.BALROG_PLATFORM_MAP`` does for
# the update platforms. It is also the list of platforms we handle: a
# dependency on any other one is ignored.
#
# macOS uses the aarch64 target rather than the universal one. The enterprise
# build had no universal binary at first, and that is how the console knows
# it.
ENTERPRISE_PLATFORM_MAP = {
    "linux64-enterprise-shippable": "Linux_x86_64-gcc3",
    "linux64-aarch64-enterprise-shippable": "Linux_aarch64-gcc3",
    "macosx64-enterprise-shippable": "Darwin_aarch64-gcc3",
    "win64-enterprise-shippable": "WINNT_x86_64-msvc",
    "win64-aarch64-enterprise-shippable": "WINNT_aarch64-msvc-aarch64",
}

# Maps a dependency kind to the ``type`` of blob it provides and a function
# building the artifact path from the repack config and the locale. The path is
# relative to the dependency's own ``artifact_prefix`` and is looked up in its
# ``release_artifacts``, so where each kind publishes is not repeated here.
BLOB_SPECS = {
    "mar-signing": (
        "complete_mar",
        lambda repack_config, locale: (
            "target.complete.mar"
            if locale == "en-US"
            else f"{locale}/target.complete.mar"
        ),
    ),
    "repackage-signing-msi": (
        "windows_msi",
        lambda repack_config, locale: f"{locale}/target.installer.msi",
    ),
    "repackage-deb": (
        "linux_deb",
        lambda repack_config, locale: f"{locale}/target.deb",
    ),
    "enterprise-repack-mac-notarization": (
        "macos_pkg",
        lambda repack_config, locale: f"{repack_config}/{locale}/target.pkg",
    ),
}

# How a blob addresses its artifact: through the taskcluster proxy, which
# authenticates with the reading task's own scopes and redirects to wherever
# the queue stores the artifact. The client fetching it needs no credentials of
# its own, but must follow redirects. ``http://taskcluster`` is where
# docker-worker exposes the proxy (its ``TASKCLUSTER_PROXY_URL``).
# ``<label>`` is replaced with the dependency's task id by ``task-reference``
# substitution.
ARTIFACT_URL = "http://taskcluster/queue/v1/task/<{label}>/artifacts/{path}"


@transforms.add
def make_release_definitions(config, tasks):
    for task in tasks:
        release_config = task.pop("release-config")
        build_assets = task.pop("build-assets")
        releases = _collect_releases(get_dependencies(config, task))

        if not releases and config.params["release_enable_enterprise_repack"]:
            raise Exception(
                "No enterprise release definition could be built: none of the "
                f"{sorted(BLOB_SPECS)} dependencies yielded a repack config. "
                "Without this check the kind would silently emit no tasks at all."
            )

        for repack_config, (variants, labels) in sorted(releases.items()):
            new_task = copy.deepcopy(task)
            new_task["name"] = repack_config.replace("/", "-")
            new_task["dependencies"] = {label: label for label in sorted(labels)}
            # The repack this release belongs to. The registry reference is
            # derived from it: `enterprise_oci_registry` reads it from here,
            # and the tag task reads it from this task.
            new_task.setdefault("extra", {})["repack_config"] = repack_config

            definition = _build_definition(
                config, release_config, build_assets, variants
            )
            worker = new_task.setdefault("worker", {})
            worker.setdefault("env", {})["RELEASE_DEFINITION"] = {
                "task-reference": json.dumps(definition, separators=(",", ":"))
            }
            yield new_task


def _repack(dep):
    """The repack config a dependency covers, as ``(config, locales)``.

    Every kind fanned out per repack carries this on its ``extra``, set where
    the fan-out happens: ``chunk_partners`` for the macOS chain,
    ``repackage.py`` for the deb/msi/msix chain, and ``repackage_signing``
    passes it along. A dependency without it is not a repack, like the plain
    per-locale MSIs, and contributes nothing.
    """
    extra = dep.task.get("extra", {})
    if extra.get("repack_config"):
        return extra["repack_config"], extra["repack_locales"]
    return None, []


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
    """Group dependency artifacts into releases keyed by repack config.

    Returns ``{repack_config: (variants, labels)}`` where ``variants``
    maps ``(build_target, locale) -> {blob_type: artifact url}`` and
    ``labels`` is the set of dependency labels the release references. Keying
    by blob type keeps one artifact per type per variant; the definition itself
    wants a list, which ``_build_definition`` flattens it into. The ``<label>``
    tokens in the URLs are resolved to task IDs later via ``task-reference``
    substitution.

    ``mar-signing`` dependencies belong to no repack, so they are held back
    and then attached to the variants the per-repack dependencies created for
    the same build target. A variant therefore only exists if a per-repack
    artifact backs it, and is never a MAR on its own.

    A blob is only emitted for an artifact the dependency lists in
    ``release_artifacts``. A locale the shared MAR signing task does not cover
    simply has no MAR, rather than a URL to a file nobody published.
    """
    releases = {}
    shared = []

    for dep in deps:
        build_target = ENTERPRISE_PLATFORM_MAP.get(dep.attributes.get("build_platform"))
        spec = BLOB_SPECS.get(dep.kind)
        if build_target is None or spec is None:
            continue

        # `mar-signing` is per build platform, not per repack, so its
        # artifacts are shared by every repack of that platform. Naming the
        # kind is the only way to tell: the plain MSIs on an enterprise
        # platform also carry no repack config and publish the same paths.
        if dep.kind == "mar-signing":
            shared.append((build_target, dep, spec))
            continue

        blob_type, relpath_for = spec
        repack_config, locales = _repack(dep)
        if not repack_config:
            continue
        for locale in locales:
            path = _artifact_path(dep, relpath_for(repack_config, locale))
            if path is None:
                continue
            variants, labels = releases.setdefault(repack_config, ({}, set()))
            variants.setdefault((build_target, locale), {})[blob_type] = (
                ARTIFACT_URL.format(label=dep.label, path=path)
            )
            labels.add(dep.label)

    for repack_config, (variants, labels) in releases.items():
        for shared_target, dep, (blob_type, relpath_for) in shared:
            for build_target, locale in variants:
                if build_target != shared_target:
                    continue
                path = _artifact_path(dep, relpath_for(repack_config, locale))
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
