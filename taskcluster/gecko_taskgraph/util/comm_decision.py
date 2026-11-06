# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
The Thunderbird (comm) task graph of the Enterprise Firefox repositories.

The Gecko decision task only checks out Gecko. For the comm graph, it creates
a copy of itself with mozilla_taskgraph's replicate transform (the
`comm-decision` kind). The copy runs with the same scopes, worker pool, caches
and image. It also checks out the Thunderbird revision pinned in
`.comm_rev.yml` and runs `mach taskgraph decision --root=comm/taskcluster`. The
comm graph goes into the copy's own task group, and the copy is indexed as
`<trust-domain>.v2.<project>.revision.<rev>.taskgraph.comm-decision`.
"""

import copy
import json
import logging
import os
import re
import shlex
from types import SimpleNamespace

from taskgraph.util import yaml
from taskgraph.util.taskcluster import get_task_definition

from gecko_taskgraph import GECKO

logger = logging.getLogger(__name__)

COMM_REV_FILE = os.path.join(GECKO, ".comm_rev.yml")

# Gecko project -> project of the comm graph it generates.
COMM_PROJECTS = {
    "enterprise-firefox": "enterprise-thunderbird",
    "enterprise-firefox-try": "enterprise-thunderbird-try",
}

COMM_DECISION_LABEL = "comm-decision"

GECKO_CHECKOUT = "/builds/worker/checkouts/gecko"
COMM_CHECKOUT_ARGS = [f"--comm-checkout={GECKO_CHECKOUT}/comm", "--comm-shallow-clone"]
REPOSITORIES = {"gecko": "Mozilla Firefox", "comm": "Mozilla Thunderbird"}


def get_comm_env(head_ref):
    """The COMM_* environment for the Thunderbird revision pinned for the Gecko
    branch `head_ref`."""
    with open(COMM_REV_FILE) as fh:
        conf = yaml.load_stream(fh)
    branch = head_ref.removeprefix("refs/heads/")
    ref = conf["refs"].get(branch, conf["refs"]["default"])
    return {
        "COMM_BASE_REPOSITORY": conf["base-repository"],
        "COMM_BASE_REF": ref,
        "COMM_BASE_REV": conf["base-rev"],
        "COMM_HEAD_REPOSITORY": conf["head-repository"],
        "COMM_HEAD_REF": ref,
        "COMM_HEAD_REV": conf["head-rev"],
        "COMM_REPOSITORY_TYPE": "git",
    }


def comm_script(trust_domain, mach_args):
    """The shell script running `mach taskgraph <mach_args>` on the comm graph."""
    return " && ".join([
        f"cd {GECKO_CHECKOUT}",
        "ln -s /builds/worker/artifacts artifacts",
        # comm/taskcluster/config.yml comes from Thunderbird, run its graph in
        # this trust domain.
        f"sed -i 's|^trust-domain: .*|trust-domain: {trust_domain}|g' comm/taskcluster/config.yml",
        f"sed -i 's|^    scope-prefix: .*|    scope-prefix: project:{trust_domain}:releng|g' comm/taskcluster/config.yml",
        shlex.join([
            "./mach",
            "--log-no-times",
            "taskgraph",
            *mach_args,
            "--root=comm/taskcluster",
        ]),
    ])


def replicate_task(graph_config, params, task_id, name):
    """Copy the definition of `task_id` with mozilla_taskgraph's replicate
    transform, into the task group of the running task.

    Returns the task description and the original definition.
    """
    from mozilla_taskgraph.transforms.replicate import rewrite_task  # noqa: PLC0415

    original = copy.deepcopy(get_task_definition(task_id))
    # Only the rewriting step of the transform is used. `resolve_targets` would
    # look for a `public/task-graph.json` on the target first, and it expects
    # `{"task": definition}` for a plain task, which queue.task() doesn't return.
    config = SimpleNamespace(graph_config=graph_config, params=params)
    (taskdesc,) = list(
        rewrite_task(config, [{"task": copy.deepcopy(original), "name-prefix": name}])
    )
    return taskdesc, original


def make_comm_task(
    taskdesc,
    original,
    *,
    label,
    name,
    description,
    env,
    script,
    routes,
    treeherder,
):
    """Turn a replicated Gecko decision or action task into its comm variant."""
    task = taskdesc["task"]
    payload = task["payload"]

    # replicate drops every *_REV variable, so that a task copied from an old
    # push doesn't build an old revision. This copy has to build exactly the
    # revision of the task it copies.
    payload["env"].update({
        k: v for k, v in original["payload"]["env"].items() if k.endswith("_REV")
    })
    payload["env"].update(env)
    payload["env"]["REPOSITORIES"] = json.dumps(REPOSITORIES)
    if "RUN_TASK_RESOURCE_USAGE_NAME" in payload["env"]:
        payload["env"]["RUN_TASK_RESOURCE_USAGE_NAME"] = name

    command = payload["command"]
    separator = command.index("--")
    command[separator:separator] = [
        arg for arg in COMM_CHECKOUT_ARGS if arg not in command
    ]
    command[-1] = script

    # Actions need the artifacts of the decision and action tasks (parameters,
    # graphs, actions.json) for as long as they need the decision task's.
    task["expires"] = {"relative-datestamp": "1 year 1 second"}
    for artifact_name, artifact in payload.get("artifacts", {}).items():
        artifact["expires"] = {
            "relative-datestamp": (
                "7 days" if artifact_name == "public/docker-contexts" else "1 year"
            )
        }

    task["priority"] = original["priority"]
    task["routes"] = routes
    if treeherder:
        task["extra"]["treeherder"] = treeherder
    task["metadata"]["name"] = name
    task["metadata"]["description"] = description
    # Chain of trust requires the source of a task with a Thunderbird checkout
    # to be in the Thunderbird repository (scriptworker's get_source_url).
    task["metadata"]["source"] = (
        f"{env['COMM_HEAD_REPOSITORY']}/raw/{env['COMM_HEAD_REV']}/.taskcluster.yml"
    )

    taskdesc["label"] = label
    taskdesc["description"] = description
    return taskdesc


def get_comm_decision_treeherder(decision_treeherder=None):
    """Treeherder configuration of the comm decision task, next to the Gecko
    decision task's."""
    treeherder = copy.deepcopy(decision_treeherder or {})
    treeherder.setdefault("machine", {"platform": "gecko-decision"})
    # Required of the tasks of a graph, unlike of the decision task.
    treeherder.setdefault("collection", {"opt": True})
    treeherder["symbol"] = "DC"
    return treeherder


def get_comm_decision_routes(routes):
    """The routes of the comm decision task generated by a decision task with
    these routes.

    The comm decision task is on the same Treeherder push. It is indexed as
    `...taskgraph.comm-decision` where the decision task is indexed as
    `...taskgraph.decision`.
    """
    comm_routes = []
    for route in routes:
        if match := re.match(r"^index\.(.+)\.taskgraph\.decision$", route):
            comm_routes.append(f"index.{match.group(1)}.taskgraph.comm-decision")
        elif not route.startswith("index."):
            comm_routes.append(route)
    return comm_routes


def make_comm_decision_task(graph_config, params):
    """Copy the running Gecko decision task into the comm decision task."""
    trust_domain = graph_config["trust-domain"]
    taskdesc, original = replicate_task(
        graph_config, params, os.environ["TASK_ID"], COMM_DECISION_LABEL
    )

    args = [
        "decision",
        "--pushlog-id=0",
        "--pushdate=0",
        f"--project={COMM_PROJECTS[params['project']]}",
        f"--owner={params['owner']}",
        f"--level={params['level']}",
        f"--repository-type={params['repository_type']}",
        f"--tasks-for={params['tasks_for']}",
        f"--base-repository={params['base_repository']}",
        f"--base-rev={params['base_rev']}",
        f"--head-repository={params['head_repository']}",
        f"--head-ref={params['head_ref']}",
        f"--head-rev={params['head_rev']}",
    ]
    # The Gecko decision task allows parameter overrides on development
    # repositories (try).
    if "--allow-parameter-override" in original["payload"]["command"][-1]:
        args.append("--allow-parameter-override")

    routes = get_comm_decision_routes(original["routes"])
    env = get_comm_env(params["head_ref"])

    treeherder = get_comm_decision_treeherder(original["extra"].get("treeherder"))

    taskdesc = make_comm_task(
        taskdesc,
        original,
        label=COMM_DECISION_LABEL,
        name=f"Comm {original['metadata']['name']}",
        description="The task that creates all Thunderbird tasks of this push",
        env=env,
        script=comm_script(trust_domain, args),
        routes=routes,
        treeherder=treeherder,
    )
    taskdesc["task"]["tags"]["project"] = COMM_PROJECTS[params["project"]]
    # Never optimized away: nothing else in the Gecko graph depends on it.
    taskdesc["optimization"] = None
    return taskdesc
