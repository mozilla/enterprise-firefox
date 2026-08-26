#!/usr/bin/env python3

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Generate one report task per task of the try push of this branch.

Finds the branch of this pull request in the try repository, resolves its first
commit to the decision task indexed under
<trust-domain>.v2.<project>.revision.<revision>.taskgraph.decision, waits for
that decision task, and reads the task graph it published. Every task in there
gets a try-status-report task in this task group, depending on the completion of
the task it monitors.

Nothing here authenticates to GitHub. The generated tasks carry the `checks`
route, the one `code-review` tasks are given, and Taskcluster reports them on the
pull request by itself.

Standard library only, the base image has neither jq nor curl.
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

USER_AGENT = "enterprise-try-status (+https://github.com/mozilla/enterprise-firefox)"

HTTP_ATTEMPTS = 3
# How long to wait for the try push to show up. A push to try lands its branch
# first, and only gets indexed once its decision task has completed, so both are
# waited on under this one deadline.
PUSH_TIMEOUT = 900
PUSH_INTERVAL = 30
# How long to wait for the try decision task to resolve.
DECISION_TIMEOUT = 1800
DECISION_INTERVAL = 30
# Refuse to flood a pull request beyond this.
MAX_REPORTS = 500
# Prefixes that keep a report distinguishable from the job it mirrors, both in
# the task label and on the treeherder row it lands on.
REPORT_PREFIX = "try-status-report-"
PLATFORM_PREFIX = "try-"
# The kind holds create-task at `highest`, which is the priority the repository
# role grants, and that satisfies creating a task at any priority. These are
# cheap and wait on a dependency anyway, so they go to the back of the queue.
REPORT_PRIORITY = "very-low"
# Days before a report task gives up waiting, and before its artifacts expire.
REPORT_DEADLINE_DAYS = 3
REPORT_EXPIRES_DAYS = 28


def log(message):
    print(message, flush=True)


def request(url, method="GET", body=None, raw=False):
    headers = {"User-Agent": USER_AGENT}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"

    last = None
    for attempt in range(1, HTTP_ATTEMPTS + 1):
        message = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(message, timeout=120) as response:
                payload = response.read()
                if raw:
                    return payload
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as error:
            if 400 <= error.code < 500 and error.code != 429:
                raise
            last = error
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last = error
        if attempt < HTTP_ATTEMPTS:
            time.sleep(2**attempt)
    raise RuntimeError(f"{method} {url} failed after {HTTP_ATTEMPTS} attempts: {last}")


def slugid():
    return base64.urlsafe_b64encode(uuid.uuid4().bytes).rstrip(b"=").decode()


def stamp(days=0, seconds=0):
    moment = time.gmtime(time.time() + days * 86400 + seconds)
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", moment)


def branch_refs(remote, branch):
    """The commits `git ls-remote` reports for this branch, as [(sha, ref)].

    A pattern is matched against the tail of each ref, so the bare branch name
    of the pull request also finds the refs/heads/user/<user>/<branch> copies
    that `mach try` pushes.
    """
    listing = subprocess.run(
        ["git", "ls-remote", "--heads", remote, branch],
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
    ).stdout
    return [
        (sha, ref)
        for sha, _, ref in (line.partition("\t") for line in listing.splitlines())
        if ref.rpartition("/")[2] == branch
    ]


def second_commit(workdir, remote, sha):
    """The commit under `sha`, without any of the tree behind it.

    A try push is the branch with one commit on top holding what to run, so the
    commit under the tip is the one the developer pushed. `tree:0` keeps this to
    the commit objects, which is a fraction of a second rather than a clone.
    """

    def git(*args):
        return subprocess.run(
            ["git", "-C", workdir, *args],
            check=True,
            capture_output=True,
            text=True,
            timeout=300,
        ).stdout.strip()

    try:
        git("fetch", "-q", "--depth=2", "--filter=tree:0", remote, sha)
        return git("rev-parse", f"{sha}^")
    except subprocess.CalledProcessError as error:
        log(f"Could not read the commit under {sha[:12]}: {error.stderr.strip()}")
        return None


def wait_for_try_push(root_url, trust_domain, project, remote, branch, head_rev):
    """Wait for the try push of this pull request, and its decision task.

    A branch of this name is not enough: `mach try` pushes the branch with one
    commit on top, so the commit under the tip has to be the head of the pull
    request, or the push is of some other revision and reporting it here would
    be a lie. Several users can also hold a branch of the same name, and this is
    what tells them apart.

    Pushing to try is not instant from here either: the branch appears first,
    and the index entry only exists once the decision task has completed.
    """
    workdir = tempfile.mkdtemp(prefix="try-status-")
    subprocess.run(["git", "init", "-q", workdir], check=True, timeout=60)

    deadline = time.monotonic() + PUSH_TIMEOUT
    under = {}
    while True:
        refs = branch_refs(remote, branch)
        waiting = f"no branch named '{branch}' yet"

        for sha, ref in refs:
            if sha not in under:
                under[sha] = second_commit(workdir, remote, sha)
            parent = under[sha]
            if parent != head_rev:
                log(
                    f"  {ref} -> {sha[:12]} sits on {(parent or '?')[:12]}, not {head_rev[:12]}"
                )
                waiting = f"'{branch}' is pushed, but from another revision"
                continue

            log(f"  {ref} -> {sha[:12]} sits on {head_rev[:12]}")
            decision_id = decision_task_of(root_url, trust_domain, project, sha)
            if decision_id:
                return sha, decision_id
            waiting = (
                f"{sha[:12]} is not indexed yet, its decision task may still be running"
            )

        if time.monotonic() >= deadline:
            log(f"Gave up after {PUSH_TIMEOUT}s: {waiting}")
            return None, None
        log(f"{waiting}, retrying in {PUSH_INTERVAL}s")
        time.sleep(PUSH_INTERVAL)


def decision_task_of(root_url, trust_domain, project, revision):
    namespace = f"{trust_domain}.v2.{project}.revision.{revision}.taskgraph.decision"
    log(f"Looking up {namespace}")
    try:
        return request(f"{root_url}/api/index/v1/task/{namespace}")["taskId"]
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def wait_for(root_url, task_id):
    """Wait until a task stops running, and return its state."""
    deadline = time.monotonic() + DECISION_TIMEOUT
    while True:
        status = request(f"{root_url}/api/queue/v1/task/{task_id}/status")["status"]
        state = status["state"]
        if state not in ("unscheduled", "pending", "running"):
            return state
        if time.monotonic() >= deadline:
            return state
        log(f"Decision task is {state}, waiting {DECISION_INTERVAL}s")
        time.sleep(DECISION_INTERVAL)


def published_task_graph(root_url, task_id):
    url = f"{root_url}/api/queue/v1/task/{task_id}/artifacts/public%2Ftask-graph.json"
    return json.loads(request(url, raw=True))


def report_task(
    template, monitored, monitored_id, script, treeherder_url, project, revision
):
    """Build the task that monitors one task of the try push.

    It keeps the treeherder placement of the task it monitors, so that it reads
    the same way, with the platform prefixed: these land on the pull request push
    next to the jobs of that pull request, and the two have to be told apart.
    """
    label = monitored.get("label") or monitored["task"]["metadata"]["name"]
    name = f"{REPORT_PREFIX}{label}"
    task_url = f"{treeherder_url}/jobs?{urllib.parse.urlencode({'repo': project, 'revision': revision})}"

    treeherder = dict(monitored["task"].get("extra", {}).get("treeherder", {}))
    machine = dict(treeherder.get("machine", {}))
    machine["platform"] = "{}{}".format(
        PLATFORM_PREFIX, machine.get("platform", "other")
    )
    treeherder["machine"] = machine

    # Deliberately not inheriting the environment of this task: that one is set
    # up for run-task and a checkout, and the worker provides
    # TASKCLUSTER_ROOT_URL by itself.
    environment = {
        "TRY_STATUS_TASK_ID": monitored_id,
        "TRY_STATUS_TASK_LABEL": label,
        "TRY_STATUS_TASK_URL": f"{task_url}&selectedTaskRun={monitored_id}.0",
        "MOZ_UPLOAD_DIR": "/builds/worker/artifacts",
    }

    # The image of an in-tree docker task is an artifact of the task that built
    # it, which the worker mounts, and it will not mount an artifact of a task it
    # does not depend on.
    dependencies = [monitored_id]
    image = template["payload"]["image"]
    if isinstance(image, dict) and image.get("taskId"):
        dependencies.append(image["taskId"])

    routes = ["checks"] + [
        route
        for route in template.get("routes", [])
        if route.startswith("tc-treeherder.")
    ]

    return {
        "taskGroupId": template["taskGroupId"],
        "schedulerId": template["schedulerId"],
        "projectId": template.get("projectId", "none"),
        "provisionerId": template["provisionerId"],
        "workerType": template["workerType"],
        "priority": REPORT_PRIORITY,
        # The point of the whole thing: hold this task until the task it
        # monitors has resolved, whatever it resolved to.
        "dependencies": dependencies,
        "requires": "all-resolved",
        "created": stamp(),
        "deadline": stamp(days=REPORT_DEADLINE_DAYS),
        "expires": stamp(days=REPORT_EXPIRES_DAYS),
        "scopes": [],
        "routes": routes,
        "payload": {
            "image": template["payload"]["image"],
            "maxRunTime": 1800,
            "env": environment,
            "command": [
                "/bin/bash",
                "-cx",
                f"echo {base64.b64encode(script.encode()).decode()} | base64 -d > /tmp/try-status-report.py && "
                "python3 /tmp/try-status-report.py",
            ],
            "artifacts": {
                "public/try-status": {
                    "type": "directory",
                    "path": "/builds/worker/artifacts",
                    "expires": stamp(days=REPORT_EXPIRES_DAYS),
                }
            },
        },
        "metadata": {
            "name": name,
            "description": f"Outcome of `{label}` on the try push of this branch",
            "owner": template["metadata"]["owner"],
            "source": template["metadata"]["source"],
        },
        "tags": {"kind": "try-status-report", "label": name},
        "extra": {"treeherder": treeherder, "try-status": {"taskId": monitored_id}},
    }


def artifact(name, content):
    directory = os.environ.get("MOZ_UPLOAD_DIR", "/builds/worker/artifacts")
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)
    log(f"Wrote {path}")


def main():
    root_url = os.environ["TASKCLUSTER_ROOT_URL"].rstrip("/")
    proxy_url = os.environ["TASKCLUSTER_PROXY_URL"].rstrip("/")
    trust_domain = os.environ["TRY_STATUS_TRUST_DOMAIN"]
    project = os.environ["TRY_STATUS_TRY_PROJECT"]
    remote = os.environ["TRY_STATUS_TRY_REMOTE"]
    treeherder_url = os.environ["TRY_STATUS_TREEHERDER_URL"].rstrip("/")
    branch = os.environ.get("TRY_STATUS_HEAD_REF", "").removeprefix("refs/heads/")
    head_rev = os.environ["TRY_STATUS_HEAD_REV"]

    with open(os.environ["TRY_STATUS_REPORT_SCRIPT"], encoding="utf-8") as handle:
        script = handle.read()

    template = request(f"{root_url}/api/queue/v1/task/{os.environ['TASK_ID']}")

    log(f"Looking for a try push of '{branch}' on {head_rev[:12]} in {remote}")
    revision, decision_id = wait_for_try_push(
        root_url, trust_domain, project, remote, branch, head_rev
    )
    if decision_id is None:
        log(f"::error::no {project} push found for branch '{branch}'")
        log("Push it with `./mach try` and update this pull request.")
        return 1

    log(f"Try decision task is {decision_id}")
    state = wait_for(root_url, decision_id)
    if state in ("unscheduled", "pending", "running"):
        log(f"::error::gave up waiting for the try decision task, it is {state}")
        return 1
    if state != "completed":
        log(f"::error::the try decision task is {state}, so it published no graph")
        return 1

    graph = published_task_graph(root_url, decision_id)
    log(f"The try push generated {len(graph)} task(s)")

    created = []
    for monitored_id, monitored in sorted(graph.items()):
        if len(created) >= MAX_REPORTS:
            log(f"Stopping at {MAX_REPORTS} report tasks, {len(graph)} were found")
            break
        definition = report_task(
            template, monitored, monitored_id, script, treeherder_url, project, revision
        )
        task_id = slugid()
        request(f"{proxy_url}/queue/v1/task/{task_id}", method="PUT", body=definition)
        log(f"  {definition['metadata']['name']} -> {task_id} on {monitored_id}")
        created.append({
            "taskId": task_id,
            "monitors": monitored_id,
            "label": definition["metadata"]["name"],
        })

    artifact(
        "generated-tasks.json",
        json.dumps(
            {
                "branch": branch,
                "revision": revision,
                "decisionTaskId": decision_id,
                "taskGroupUrl": f"{root_url}/tasks/groups/{decision_id}",
                "treeherderUrl": "{}/jobs?{}".format(
                    treeherder_url,
                    urllib.parse.urlencode({"repo": project, "revision": revision}),
                ),
                "tasks": created,
            },
            indent=2,
        ),
    )
    log(f"Generated {len(created)} report task(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
