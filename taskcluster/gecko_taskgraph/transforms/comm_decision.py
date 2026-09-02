# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Build the comm (Thunderbird) decision task from the thunderbird-desktop
revision resolved by this decision task.

The comm checkout is wired up by hand rather than through ``run.comm-checkout``
because that path reads the ``comm_head_*`` parameters, which are the comm
graph's own parameter set and are absent here. See
``gecko_taskgraph.decision.set_comm_decision_parameters``.
"""

import json

from taskgraph.transforms.base import TransformSequence

pre_job_transforms = TransformSequence()
post_job_transforms = TransformSequence()

COMM_TRUST_DOMAIN = "enterprise"
COMM_PROJECT = "enterprise-thunderbird"
COMM_SCOPE_PREFIX = "project:enterprise:releng"


def _comm_params(config):
    params = config.params
    repository = params.get("comm_decision_repository")
    ref = params.get("comm_decision_ref")
    rev = params.get("comm_decision_rev")
    if repository and ref and rev:
        return repository, ref, rev
    return None


@pre_job_transforms.add
def build_decision_command(config, tasks):
    for task in tasks:
        comm = _comm_params(config)
        if comm is None:
            # No thunderbird-desktop branch maps to this one, or this is a
            # local `mach taskgraph` run with no resolved revision.
            continue
        repository, ref, rev = comm
        params = config.params

        env = task["worker"].setdefault("env", {})
        env.update({
            "COMM_BASE_REPOSITORY": repository,
            "COMM_HEAD_REPOSITORY": repository,
            "COMM_BASE_REF": ref,
            "COMM_HEAD_REF": ref,
            "COMM_BASE_REV": rev,
            "COMM_HEAD_REV": rev,
            "COMM_REPOSITORY_TYPE": "git",
        })
        # comm/taskcluster/config.yml is Thunderbird's, and carries
        # Thunderbird's trust domain and scope prefix.
        task["run"]["command"] = " ".join([
            "ln -s /builds/worker/artifacts artifacts &&",
            f"sed -i 's|^trust-domain: .*|trust-domain: {COMM_TRUST_DOMAIN}|g'",
            "comm/taskcluster/config.yml &&",
            "sed -i 's|^    scope-prefix: .*|    scope-prefix:"
            f" {COMM_SCOPE_PREFIX}|g' comm/taskcluster/config.yml &&",
            "./mach --log-no-times taskgraph decision",
            "--root=comm/taskcluster",
            "--pushlog-id='0'",
            "--pushdate='0'",
            f"--project='{COMM_PROJECT}'",
            f"--owner='{params['owner']}'",
            f"--level='{params['level']}'",
            "--repository-type=git",
            f"--tasks-for='{params['tasks_for']}'",
            f"--base-repository='{params['base_repository']}'",
            f"--base-rev='{params['base_rev']}'",
            f"--head-repository='{params['head_repository']}'",
            f"--head-ref='{params['head_ref']}'",
            f"--head-rev='{params['head_rev']}'",
        ])

        """
        task.setdefault("scopes", []).append(
            "assume:repo:{}:branch:{}".format(
                params["head_repository"].split("://", 1)[1],
                params["head_ref"].removeprefix("refs/heads/"),
            )
        )
        """

        yield task


@post_job_transforms.add
def add_comm_checkout(config, tasks):
    for task in tasks:
        env = task["worker"]["env"]
        command = task["worker"]["command"]

        # The run-task transform emits the in-tree docker image layout,
        # /builds/worker/bin/run-task-{git,hg}. This task runs on the upstream
        # taskgraph image, which ships the same script as ``run-task`` on PATH.
        command[0] = "run-task"

        separator = command.index("--")
        command[separator:separator] = [
            "--comm-checkout={}/comm".format(env["GECKO_PATH"]),
            "--comm-shallow-clone",
        ]

        # REPOSITORIES is rebuilt from the graph config's repositories by
        # ``support_vcs_checkout``, so comm has to be added back afterwards.
        repositories = json.loads(env["REPOSITORIES"])
        repositories["comm"] = "Mozilla Thunderbird"
        env["REPOSITORIES"] = json.dumps(repositories)

        yield task
