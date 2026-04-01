# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Transform the geckodriver notarization task into an actual task description.
"""

from typing import Optional

from taskgraph.transforms.base import TransformSequence
from taskgraph.util.dependencies import get_primary_dependency
from taskgraph.util.schema import Schema

from gecko_taskgraph.transforms.task import TaskDescriptionSchema
from gecko_taskgraph.util.attributes import copy_attributes_from_dependent_job


class GeckodriverNotarizationDescriptionSchema(Schema, kw_only=True):
    label: Optional[str] = None
    treeherder: TaskDescriptionSchema.__annotations__["treeherder"] = None
    shipping_phase: TaskDescriptionSchema.__annotations__["shipping_phase"] = None
    worker: TaskDescriptionSchema.__annotations__["worker"] = None
    worker_type: TaskDescriptionSchema.__annotations__["worker_type"] = None
    task_from: TaskDescriptionSchema.__annotations__["task_from"] = None
    attributes: TaskDescriptionSchema.__annotations__["attributes"] = None
    dependencies: TaskDescriptionSchema.__annotations__["dependencies"] = None
    run_on_repo_type: TaskDescriptionSchema.__annotations__["run_on_repo_type"] = None


transforms = TransformSequence()


@transforms.add
def remove_name(config, jobs):
    for job in jobs:
        if "name" in job:
            del job["name"]
        yield job


transforms.add_validate(GeckodriverNotarizationDescriptionSchema)


@transforms.add
def geckodriver_mac_notarization(config, jobs):
    for job in jobs:
        dep_job = get_primary_dependency(config, job)
        assert dep_job

        attributes = copy_attributes_from_dependent_job(dep_job)
        treeherder = job.get("treeherder", {})
        dep_treeherder = dep_job.task.get("extra", {}).get("treeherder", {})
        treeherder.setdefault(
            "platform", dep_job.task.get("extra", {}).get("treeherder-platform")
        )
        treeherder.setdefault("tier", dep_treeherder.get("tier", 1))
        treeherder.setdefault("kind", "build")

        dependencies = {dep_job.kind: dep_job.label}

        description = "Mac notarization - Geckodriver for build '{}'".format(
            attributes.get("build_platform"),
        )

        build_platform = dep_job.attributes.get("build_platform")

        job["worker"]["signing-type"] = "release-apple-notarization"

        platform = build_platform.rsplit("-", 1)[0]

        task = {
            "label": job["label"],
            "description": description,
            "worker-type": job["worker-type"],
            "worker": job["worker"],
            "dependencies": dependencies,
            "attributes": attributes,
            "treeherder": treeherder,
            "run-on-projects": ["mozilla-central"],
            "run-on-repo-type": job.get("run-on-repo-type", ["git", "hg"]),
            "index": {"product": "geckodriver", "job-name": f"{platform}-notarized"},
        }
        yield task
