# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Sign the complete MARs an enterprise repack repackage task produced.

``mar-signing`` signs the MAR built from the generic build, whose
``firefox.cfg`` holds the ``FIREFOX_ENTERPRISE_GENERIC`` placeholder rather
than the repack's console address, so the enterprise update pipeline signs the
repacked MARs instead. The signing format selection is shared with
``mar-signing`` through ``generate_complete_artifacts``; what differs is that
every task here is specific to one repack, so the label, the treeherder symbol
and the index namespace all have to be qualified by it -- otherwise repacks of
the same build platform collide and overwrite one another.
"""

from mozilla_taskgraph.util.attributes import copy_attributes_from_dependent_job
from taskgraph.transforms.base import TransformSequence
from taskgraph.util.dependencies import get_primary_dependency
from taskgraph.util.treeherder import inherit_treeherder_from_dep

from gecko_taskgraph.transforms.mar_signing import generate_complete_artifacts
from gecko_taskgraph.util.scriptworker import get_signing_type_per_platform

transforms = TransformSequence()

# The keys identifying the repack a task covers, as `chunk_partners` sets them
# on its `extra`. Passed through so downstream consumers -- `_repack` in
# `enterprise_release_definition` -- find them here too.
REPACK_KEYS = ("repack_config", "repack_locales", "repack_id")


def _repack(extra):
    """The repack a dependency covers, as ``(name, locales)``.

    Partner and eme-free repacks fan out to one task per locale, keyed by a
    ``{partner}/{sub_config}/{locale}`` repack id. Enterprise repacks stop one
    level short: one task per ``{partner}/{sub_config}``, holding all of its
    locales. Either way every MAR the repack produced has to be signed.
    """
    if extra.get("repack_config"):
        return extra["repack_config"], extra["repack_locales"]
    repack_id = extra["repack_id"]
    return repack_id, [repack_id.split("/")[2]]


@transforms.add
def make_task_description(config, jobs):
    for job in jobs:
        dep_job = get_primary_dependency(config, job)
        assert dep_job

        extra = dep_job.task["extra"]
        repack, locales = _repack(extra)
        partner, sub_config = repack.split("/")[:2]
        build_platform = dep_job.attributes.get("build_platform")
        is_shippable = dep_job.attributes.get("shippable")

        attributes = copy_attributes_from_dependent_job(dep_job)
        # The repack carries the locales; the repack tasks themselves are not
        # per-locale jobs, so the attribute is not inherited from them. The
        # l10n index builders give `locale` precedence over `chunk_locales`, so
        # only ever one of the two is set.
        attributes.pop("locale", None)
        if len(locales) == 1:
            attributes["locale"] = locales[0]
        else:
            attributes["chunk_locales"] = locales
        attributes["repackage_type"] = config.kind

        treeherder = inherit_treeherder_from_dep(job, dep_job)
        treeherder["symbol"] = "{}({})".format(
            job.get("treeherder-group", "Rpk-Ent-Ms"), repack
        )

        index = job.get("index")
        if index:
            # The route templates append the locale, so the rest of the repack
            # name has to be spelled out in the job name to keep one namespace
            # per repack.
            index["type"] = "shippable-l10n" if is_shippable else "l10n"
            index["job-name"] = (
                f"enterprise-repack-mar-signing-{partner}-{sub_config}-{build_platform}"
            )

        task = {
            "label": dep_job.label.replace(
                "enterprise-repack-repackage-", f"{config.kind}-"
            ),
            "description": (
                f"Signing of the complete MARs for enterprise repack "
                f"'{repack}' for build "
                f"'{build_platform}/{dep_job.attributes.get('build_type')}'"
            ),
            "worker-type": job.get("worker-type", "linux-signing"),
            "worker": {
                "implementation": "scriptworker-signing",
                "signing-type": get_signing_type_per_platform(
                    build_platform, is_shippable, config
                ),
                "upstream-artifacts": generate_complete_artifacts(dep_job, config.kind),
            },
            "dependencies": {dep_job.kind: dep_job.label},
            "attributes": attributes,
            "run-on-projects": job.get(
                "run-on-projects", dep_job.attributes.get("run_on_projects")
            ),
            "run-on-repo-type": job.get("run-on-repo-type", ["git", "hg"]),
            "treeherder": treeherder,
            "extra": {key: extra[key] for key in REPACK_KEYS if key in extra},
        }
        if index:
            task["index"] = index

        if (git_branches := job.get("run-on-git-branches")) is not None:
            task["run-on-git-branches"] = git_branches

        yield task
