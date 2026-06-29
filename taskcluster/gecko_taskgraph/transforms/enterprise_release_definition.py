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
  ``index.findTask``;
* build metadata (revision, build id, version, channel) comes from the decision
  parameters instead of scraping a build task's ``payload.env``;
* the policies schema/strings live in-tree at the build revision.

Every enterprise artifact is specific to a partner repack, identified by a
``repack_id`` of the form ``{partner}/{sub_config}/{locale}``. Each dependency
carries its repack id(s): the per-locale repackage/MAR tasks expose a single
``repack_id`` attribute, while the chunked macOS notarization task exposes
``extra.repack_ids``. We group all artifacts by repack id, emitting one release
definition per ``(partner, sub_config)`` with one variant per
``(build_target, locale)``.

If the graph contains no partner repacks (e.g. a non-promotion graph), no tasks
are emitted. The resulting definition is embedded into the task's
``RELEASE_DEFINITION`` env var as a single ``task-reference`` string; the
``<label>`` tokens it contains are substituted for the concrete dependency task
IDs when the task definition is finalized. The task body just writes that env
var out as an artifact.
"""

import copy
import datetime
import json
import os

from taskgraph.transforms.base import TransformSequence
from taskgraph.util.dependencies import get_dependencies

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

# Enterprise repack artifacts are published under this prefix.
ENTERPRISE_ARTIFACT_PREFIX = "project/enterprise/repacks"

# Maps a dependency kind to the release-definition blob field and a function
# building the artifact path within that task from the repack components.
BLOB_SPECS = {
    "mar-signing": (
        "complete_mar",
        lambda partner, sub_config, locale: (
            "public/build/target.complete.mar"
            if locale == "en-US"
            else f"public/build/{locale}/target.complete.mar"
        ),
    ),
    "repackage-signing-msi": (
        "windows_msi",
        lambda partner, sub_config, locale: (
            f"{ENTERPRISE_ARTIFACT_PREFIX}/target.installer.msi"
        ),
    ),
    "repackage-deb": (
        "linux_deb",
        lambda partner, sub_config, locale: f"{ENTERPRISE_ARTIFACT_PREFIX}/target.deb",
    ),
    "enterprise-repack-mac-notarization": (
        "macos_pkg",
        lambda partner, sub_config, locale: (
            f"{ENTERPRISE_ARTIFACT_PREFIX}/{partner}/{sub_config}/{locale}/target.pkg"
        ),
    ),
}

POLICIES_SCHEMA_PATH = (
    "browser/components/enterprisepolicies/schemas/policies-schema.json"
)
POLICIES_FTL_EN_US = "browser/locales/en-US/browser/policies/policies-descriptions.ftl"
# The double ``browser/`` mirrors the firefox-l10n l10n.toml mapping:
#   reference = "browser/locales/en-US/**"  ->  l10n = "{locale}/browser/**"
POLICIES_FTL_L10N = "browser/browser/policies/policies-descriptions.ftl"
L10N_REPO_RAW = "https://raw.githubusercontent.com/mozilla-l10n/firefox-l10n"
ENTERPRISE_L10N_CHANGESETS = "browser/locales/enterprise-l10n-changesets.json"


@transforms.add
def make_release_definitions(config, tasks):
    for task in tasks:
        release_config = task.pop("release-config")
        releases = _collect_releases(get_dependencies(config, task))

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

            definition = _build_definition(config, release_config, variants)
            worker = new_task.setdefault("worker", {})
            worker.setdefault("env", {})["RELEASE_DEFINITION"] = {
                "task-reference": json.dumps(definition, separators=(",", ":"))
            }
            yield new_task


def _repack_ids(dep):
    """The repack ids (``partner/sub_config/locale``) a dependency contributes.

    Per-locale repackage/MAR tasks carry a single ``repack_id`` attribute; the
    chunked macOS notarization task carries ``extra.repack_ids``.
    """
    repack_id = dep.attributes.get("repack_id")
    if repack_id:
        return [repack_id]
    return dep.task.get("extra", {}).get("repack_ids", [])


def _collect_releases(deps):
    """Group dependency artifacts into releases keyed by ``(partner, sub_config)``.

    Returns ``{(partner, sub_config): (variants, labels)}`` where ``variants``
    maps ``(build_target, locale) -> {blob_field: tc-artifact-url}`` and
    ``labels`` is the set of dependency labels the release references. The
    ``<label>`` tokens in the URLs are resolved to task IDs later via
    ``task-reference`` substitution.
    """
    releases = {}
    for dep in deps:
        build_target = BUILD_TARGETS.get(dep.attributes.get("build_platform"))
        spec = BLOB_SPECS.get(dep.kind)
        if build_target is None or spec is None:
            continue

        field, path_for = spec
        for repack_id in _repack_ids(dep):
            partner, sub_config, locale = repack_id.split("/")
            variants, labels = releases.setdefault((partner, sub_config), ({}, set()))
            url = f"tc-artifact:<{dep.label}>/{path_for(partner, sub_config, locale)}"
            variants.setdefault((build_target, locale), {})[field] = url
            labels.add(dep.label)

    return releases


def _build_definition(config, release_config, variants):
    params = config.params
    revision = params["head_rev"]
    source = params["head_repository"]
    build_id = str(params["moz_build_date"])
    raw_base = source.replace(
        "https://github.com/", "https://raw.githubusercontent.com/"
    )

    variant_list = [
        {
            "build_target": build_target,
            "locale": locale,
            "blobs": blobs,
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
        "policies": _build_policies(raw_base, revision),
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


def _build_policies(raw_base, revision):
    ftl_files = {
        "en-US": f"{raw_base}/{revision}/{POLICIES_FTL_EN_US}",
    }

    changesets_path = os.path.join(GECKO, ENTERPRISE_L10N_CHANGESETS)
    try:
        with open(changesets_path) as fh:
            changesets = json.load(fh)
    except FileNotFoundError:
        changesets = {}

    for locale, info in changesets.items():
        l10n_rev = info.get("revision")
        if not l10n_rev:
            continue
        ftl_files[locale] = f"{L10N_REPO_RAW}/{l10n_rev}/{locale}/{POLICIES_FTL_L10N}"

    return {
        "policies_schema": f"{raw_base}/{revision}/{POLICIES_SCHEMA_PATH}",
        "ftl_files": ftl_files,
    }


def _build_date_to_rfc3339(build_id):
    """Convert a ``YYYYMMDDHHMMSS`` build id into an RFC 3339 timestamp."""
    try:
        parsed = datetime.datetime.strptime(build_id, "%Y%m%d%H%M%S")
    except ValueError:
        return None
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ")
