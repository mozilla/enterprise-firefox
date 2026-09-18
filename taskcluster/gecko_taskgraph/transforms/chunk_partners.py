# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Chunk the partner repack tasks by subpartner and locale.

Enterprise repacks stop one level short and fan out by subpartner only. All the
locales of a ``{partner}/{sub_config}`` stay in one task.
"""

import copy

from mozbuild.chunkify import chunkify
from taskgraph.transforms.base import TransformSequence
from taskgraph.util.dependencies import get_primary_dependency

from gecko_taskgraph.util.partners import (
    apply_partner_priority,
    get_repack_configs_by_platform,
    get_repack_ids_by_platform,
)

transforms = TransformSequence()
transforms.add(apply_partner_priority)


def _fan_out_repack_configs(config, job, build_platform, dep_extra):
    """One job per ``{partner}/{sub_config}``, carrying all of its locales.

    The locales become entries of the task's ``repackage_config``, so the only
    fan-out left is over the repack configs. ``repack_ids`` is still set because
    ``partner_signing`` builds the signing paths from it.
    """
    if dep_extra.get("repack_config"):
        configs = {dep_extra["repack_config"]: dep_extra["repack_locales"]}
    else:
        configs = get_repack_configs_by_platform(config, build_platform)

    for repack_config, locales in configs.items():
        repack_job = copy.deepcopy(job)
        repack_job.setdefault("extra", {}).update({
            "repack_config": repack_config,
            "repack_locales": locales,
            "repack_ids": [f"{repack_config}/{locale}" for locale in locales],
        })
        yield repack_job


@transforms.add
def chunk_partners(config, jobs):
    for job in jobs:
        dep_job = get_primary_dependency(config, job)
        assert dep_job

        build_platform = dep_job.attributes["build_platform"]
        dep_extra = dep_job.task.get("extra", {})
        repack_id = dep_extra.get("repack_id")
        repack_ids = dep_extra.get("repack_ids")
        copy_repack_ids = job.pop("copy-repack-ids", False)

        if config.kind.startswith("enterprise-repack"):
            yield from _fan_out_repack_configs(config, job, build_platform, dep_extra)
        elif copy_repack_ids:
            assert repack_ids, f"dep_job {dep_job.label} doesn't have repack_ids!"
            job.setdefault("extra", {})["repack_ids"] = repack_ids
            yield job
        # first downstream of the repack task, no chunking or fanout has been done yet
        elif not any([repack_id, repack_ids]):
            platform_repack_ids = get_repack_ids_by_platform(config, build_platform)
            # we chunk mac signing
            if config.kind in (
                "release-partner-repack-signing",
                "release-eme-free-repack-signing",
                "release-eme-free-repack-mac-signing",
                "release-partner-repack-mac-signing",
            ):
                repacks_per_chunk = job.get("repacks-per-chunk")
                chunks, remainder = divmod(len(platform_repack_ids), repacks_per_chunk)
                if remainder:
                    chunks = int(chunks + 1)
                for this_chunk in range(1, chunks + 1):
                    chunk = chunkify(platform_repack_ids, this_chunk, chunks)
                    partner_job = copy.deepcopy(job)
                    partner_job.setdefault("extra", {}).setdefault("repack_ids", chunk)
                    partner_job["extra"]["repack_suffix"] = str(this_chunk)
                    yield partner_job
            # linux and windows we fan out immediately to one task per partner-sub_partner-locale
            else:
                for repack_id in platform_repack_ids:
                    partner_job = copy.deepcopy(job)  # don't overwrite dict values here
                    partner_job.setdefault("extra", {})
                    partner_job["extra"]["repack_id"] = repack_id
                    yield partner_job
        # fan out chunked mac signing for repackage
        elif repack_ids:
            for repack_id in repack_ids:
                partner_job = copy.deepcopy(job)
                partner_job.setdefault("extra", {}).setdefault("repack_id", repack_id)
                yield partner_job
        # otherwise we've fully fanned out already, continue by passing repack_id on
        else:
            partner_job = copy.deepcopy(job)
            partner_job.setdefault("extra", {}).setdefault("repack_id", repack_id)
            yield partner_job
