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

Actions work the same way. In-tree action hooks render the first task of
`.taskcluster.yml`, which is the Gecko decision task, so an action task only
has a Gecko checkout. When the action targets the comm graph, the action task
copies itself with the same transform. The copy checks out Thunderbird and runs
`mach taskgraph action-callback --root=comm/taskcluster` against the comm
decision task.

Cron works the same way too. For the Enterprise cron jobs listed in
`COMM_CRON_TARGET_TASKS_METHODS`, the Gecko cron decision task also schedules
`comm-decision`, which generates the comm graph with the same cron options
and target tasks method. The method is a Gecko one, also registered in the
comm graph, which selects the comm tasks there by `release_product`.

The comm decision task records its place in the Gecko push in the
`child_graph` parameter. The comm graph's action lookups (decision task,
action tasks) use that parameter, together with Gecko's repository and
revision, instead of the Thunderbird ones.
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

# Try pushes select comm tasks in this file, next to `try_task_config.json`
# which selects the Gecko tasks (and `comm-decision`). The two graphs share
# many labels, so they cannot share a task list.
COMM_TRY_TASK_CONFIG = "comm_try_task_config.json"

# Environment variable holding the `child_graph` parameter for the comm
# decision task, see `get_decision_parameters` in gecko_taskgraph.decision.
CHILD_GRAPH_ENV = "TASKGRAPH_CHILD_GRAPH"

# Gecko cron target tasks methods that also generate the comm graph, with the
# same method: they select the tasks of `release_product` in either graph.
COMM_CRON_TARGET_TASKS_METHODS = {"nightly_enterprise", "daily_releases_enterprise"}

# `mach taskgraph decision` options of a cron decision task, which the comm
# decision task takes over.
CRON_DECISION_OPTIONS = (
    "--target-tasks-method",
    "--include-push-tasks",
    "--rebuild-kind",
    "--optimize-target-tasks",
)

COMM_DECISION_LABEL = "comm-decision"
COMM_ACTION_LABEL = "comm-action"

GECKO_CHECKOUT = "/builds/worker/checkouts/gecko"
COMM_CHECKOUT_ARGS = [f"--comm-checkout={GECKO_CHECKOUT}/comm", "--comm-shallow-clone"]
REPOSITORIES = {"gecko": "Mozilla Firefox", "comm": "Mozilla Thunderbird"}


def child_graph_index(parameters, name):
    """Return the index path of the decision (``name="decision"``), action
    (``name="actions"``) or cron (``name="cron"``) tasks of a child graph, or
    None for a top-level one."""
    child_graph = parameters.get("child_graph")
    if not child_graph:
        return None
    return f"{child_graph['index']}-{name}"


def is_child_graph(parameters):
    return bool(parameters.get("child_graph"))


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


def get_comm_env_from_parameters(parameters):
    """The COMM_* environment of the comm graph with these parameters."""
    return {
        "COMM_BASE_REPOSITORY": parameters["comm_base_repository"],
        "COMM_BASE_REF": parameters["comm_base_ref"] or parameters["comm_head_ref"],
        "COMM_BASE_REV": parameters["comm_base_rev"],
        "COMM_HEAD_REPOSITORY": parameters["comm_head_repository"],
        "COMM_HEAD_REF": parameters["comm_head_ref"],
        "COMM_HEAD_REV": parameters["comm_head_rev"],
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
    # Next to the cron decision task's symbol in its `cron` group.
    treeherder["symbol"] = (
        f"{treeherder['symbol']}-comm" if "groupSymbol" in treeherder else "DC"
    )
    return treeherder


def get_cron_decision_options(command):
    """The cron options of a decision task's `mach taskgraph decision` script."""
    return [
        arg
        for arg in shlex.split(command)
        if arg.split("=", 1)[0] in CRON_DECISION_OPTIONS
    ]


def get_comm_decision_routes(routes):
    """The routes of the comm decision task generated by a decision task with
    these routes, and the index namespace of its comm graph.

    The comm decision task is on the same Treeherder push. It is indexed as
    `...taskgraph.comm-decision[-<cron job>]` where the decision task is
    indexed as `...taskgraph.decision[-<cron job>]`. A cron decision task's
    `...cron.<taskId>` index, which actions use to find the tasks of cron
    graphs, becomes `...taskgraph.comm-cron.<taskId>`.
    """
    comm_routes = []
    child_index = None
    for route in routes:
        if match := re.match(r"^index\.(.+)\.taskgraph\.decision(-[^.]+)?$", route):
            namespace, cron_suffix = match.group(1), match.group(2) or ""
            comm_routes.append(
                f"index.{namespace}.taskgraph.comm-decision{cron_suffix}"
            )
            # `<trust-domain>.v2.<project>[-pr].revision.<rev>`
            if ".revision." in namespace:
                child_index = f"{namespace}.taskgraph.comm"
        elif match := re.match(r"^index\.(.+\.revision\.[^.]+)\.cron\.[^.]+$", route):
            comm_routes.append({
                "task-reference": f"index.{match.group(1)}.taskgraph.comm-cron.<self>"
            })
        elif not route.startswith("index."):
            comm_routes.append(route)
    if not child_index:
        raise Exception(f"The decision task routes {routes} don't index it by revision")
    return comm_routes, child_index


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
    # A cron decision task's options: target tasks method, reuse of the push
    # tasks.
    args += get_cron_decision_options(original["payload"]["command"][-1])
    # The Gecko decision task allows parameter overrides on development
    # repositories (try), the comm one takes them from its own file.
    if "--allow-parameter-override" in original["payload"]["command"][-1]:
        args += [
            "--allow-parameter-override",
            f"--try-task-config-file={COMM_TRY_TASK_CONFIG}",
        ]

    routes, child_index = get_comm_decision_routes(original["routes"])

    # A pull request builds against the Thunderbird ref of its base branch.
    env = get_comm_env(params.get("base_ref") or params["head_ref"])
    env[CHILD_GRAPH_ENV] = json.dumps({
        "project": params["project"],
        "index": child_index,
    })

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


def get_child_action_target(task_group_id, task_id, parameters):
    """Return (task group, parameters) of the child graph an action targets,
    or None when it targets a top-level graph.

    The Taskcluster UI triggers actions from the actions.json of the targeted
    task's group, so their task group is the comm decision task. Treeherder
    always triggers them from the push's Gecko decision task, with
    `taskGroupId` set to it, even for a task of the comm graph.
    """
    from gecko_taskgraph.actions.util import get_parameters  # noqa: PLC0415

    if is_child_graph(parameters):
        return task_group_id, parameters
    if not task_id:
        return None

    group = get_task_definition(task_id)["taskGroupId"]
    if group == task_group_id:
        return None
    try:
        group_parameters = get_parameters(group)
    except Exception:
        # Not a decision task, e.g. a release promotion group.
        logger.debug(f"No parameters for task group {group}", exc_info=True)
        return None
    if is_child_graph(group_parameters):
        return group, group_parameters
    return None


def redirect_action_to_child_graph(root, task_group_id, task_id, parameters):
    """Run an action on a child comm graph from a comm copy of this action task.

    Returns True when the action was redirected, and the caller has nothing
    more to do.
    """
    from taskgraph.config import load_graph_config  # noqa: PLC0415
    from taskgraph.graph import Graph  # noqa: PLC0415
    from taskgraph.parameters import Parameters  # noqa: PLC0415
    from taskgraph.task import Task  # noqa: PLC0415
    from taskgraph.taskgraph import TaskGraph  # noqa: PLC0415

    from gecko_taskgraph.actions.util import create_tasks  # noqa: PLC0415

    graph_config = load_graph_config(root)
    if graph_config["project-repo-param-prefix"]:
        # Already running the comm graph's callbacks.
        return False

    target = get_child_action_target(task_group_id, task_id, parameters)
    if not target:
        return False
    target_group_id, target_parameters = target
    logger.info(
        f"Action on the comm graph of task group {target_group_id}, running it "
        "from a comm action task"
    )

    trust_domain = graph_config["trust-domain"]
    own_task_id = os.environ["TASK_ID"]
    params = Parameters(strict=False, **target_parameters)
    taskdesc, original = replicate_task(
        graph_config, params, own_task_id, COMM_ACTION_LABEL
    )

    env = get_comm_env_from_parameters(target_parameters)
    env["ACTION_TASK_GROUP_ID"] = target_group_id

    # Treeherder routes of this action task, and the index where the comm
    # graph's actions look for the tasks created by earlier actions.
    routes = [route for route in original["routes"] if not route.startswith("index.")]
    routes.append({
        "task-reference": f"index.{child_graph_index(target_parameters, 'actions')}.<self>"
    })

    treeherder = copy.deepcopy(original["extra"].get("treeherder"))
    if treeherder:
        treeherder["symbol"] = f"{treeherder['symbol']}-comm"

    taskdesc = make_comm_task(
        taskdesc,
        original,
        label=COMM_ACTION_LABEL,
        name=f"Comm {original['metadata']['name']}",
        description=f"Run {original['metadata']['name']} on the comm graph",
        env=env,
        script=comm_script(trust_domain, ["action-callback"]),
        routes=routes,
        treeherder=treeherder,
    )

    task = Task(
        kind=COMM_ACTION_LABEL,
        label=COMM_ACTION_LABEL,
        description=taskdesc["description"],
        attributes=taskdesc["attributes"],
        task=taskdesc["task"],
    )
    graph = TaskGraph({task.label: task}, Graph({task.label}, set()))
    # Writes the task-graph.json that chain of trust verifies the copy
    # against, and makes this action task its `extra.parent`.
    create_tasks(
        graph_config,
        [task.label],
        graph,
        {},
        params,
        decision_task_id=target_group_id,
    )
    return True
