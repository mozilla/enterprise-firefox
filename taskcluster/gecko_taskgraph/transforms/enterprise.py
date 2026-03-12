# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from copy import deepcopy
from taskgraph.transforms.base import TransformSequence
from taskgraph.util.schema import resolve_keyed_by
from taskgraph.util.dependencies import get_primary_dependency

from gecko_taskgraph.util.partners import (
    get_repack_ids_by_platform,
)

transforms = TransformSequence()

@transforms.add
def generate_enterprise_repack(config, jobs):
    public = {}
    private = {}

    for job in jobs:
        platform = job["attributes"]["build_platform"]
        artifact_public = "public/build" in job["attributes"].get("artifact_prefix", "public/build")
        if artifact_public:
            public[platform] = deepcopy(job)
        else:
            private[platform] = deepcopy(job)

    platforms = list(public.keys())
    for platform in platforms:
        repack_ids = get_repack_ids_by_platform(config, platform)
        for repack_id in repack_ids:
            repack_repo = repack_id.split("/")[0]
            repack_name = repack_id.split("/")[1]
            repack_config = config.params["release_partner_config"][config.kind][
                repack_repo
            ][repack_name]

            repack_public = (
                "public" in repack_config.keys()
                and repack_config.get("public")
            )

            j = None
            if repack_public:
                j = public[platform]
            if not repack_public:
                j = private[platform]

            #j["extra"].setdefault("repack_ids", []).append(repack_id)

    for p in public:
        j = public[p]
        yield j

    for p in private:
        j = private[p]
        yield j
