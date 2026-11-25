#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this file,
# You can obtain one at http://mozilla.org/MPL/2.0/.

"""Dispatch the enterprise-console end-to-end workflow against the upstream
Firefox build, wait for it to finish and replay its logs.

The API token is read from $GITHUB_TOKEN, which enterprise-end2end.sh populates
from the Taskcluster secrets service, and the build task handed to the workflow
from $UPSTREAM_TASKIDS.
"""

import argparse
import io
import json
import os
import sys
import time
import zipfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen

GITHUB_API = "https://api.github.com"
GITHUB_API_VERSION = "2026-03-10"

MIN_VERSION_FILE = "toolkit/components/enterprise/modules/min_version.txt"


def github_api(url, token, payload=None, raw=False):
    """Perform a GitHub API call, returning (status code, decoded body).

    With `raw`, the body is returned as bytes instead of being decoded as
    JSON: the log download endpoints redirect to an archive, so the body
    that comes back is not JSON at all.
    """
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    }

    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    try:
        with urlopen(Request(url, data=data, headers=headers)) as response:
            status, body = response.status, response.read()
    except HTTPError as error:
        status, body = error.code, error.read()

    if raw:
        return status, body

    if not body:
        return status, {}

    try:
        return status, json.loads(body)
    except ValueError:
        return status, {"message": body.decode("utf-8", "replace")}


def find_workflow(base_url, token, name):
    """Return the id of the workflow handled by 'name' ."""
    final_url = f"{base_url}/workflows/{name}"
    status, data = github_api(final_url, token)
    print(f"GitHub Workflows {final_url}: returned {status}")
    if status != 200:
        raise ValueError(
            f"github workflow list failed: {status}: {data.get('message')}"
        )

    return data["id"]


def resolve_ref(ref, repo_url, token):
    """Resolve a `--ref` name to the git ref to dispatch the workflow on.

    `main` is the console repository's main branch, `current` the tag of its
    latest release, and `minimal` the oldest release Firefox still supports.
    """
    if ref == "main":
        return "main"

    if ref == "current":
        status, data = github_api(f"{repo_url}/releases/latest", token)
        if status != 200:
            raise ValueError(
                f"github latest release failed: {status}: {data.get('message')}"
            )
        resolved = data["tag_name"]
    else:
        with open(MIN_VERSION_FILE) as version_file:
            resolved = version_file.read().strip()
        if not resolved:
            raise ValueError(f"{MIN_VERSION_FILE} holds no ref")

    print(f"GitHub ref {ref} resolved to {resolved}")
    return resolved


def newest_run(base_url, token, workflow_id, ref):
    """Return the most recently created dispatched run of `workflow_id`."""
    url = (
        f"{base_url}/workflows/{workflow_id}/runs"
        f"?event=workflow_dispatch&branch={ref}&per_page=1"
    )
    status, data = github_api(url, token)
    if status != 200:
        raise ValueError(
            f"github workflow runs failed: {status}: {data.get('message')}"
        )

    runs = data.get("workflow_runs") or []
    return runs[0] if runs else None


def dispatch(base_url, token, workflow_id, ref, inputs):
    """Dispatch the workflow and return the URL of the run it created."""
    # Run ids increase monotonically, so a run newer than the newest one at
    # dispatch time is the run we just asked for.
    previous = newest_run(base_url, token, workflow_id, ref)
    previous_id = previous["id"] if previous else 0

    url = f"{base_url}/workflows/{workflow_id}/dispatches"
    status, data = github_api(url, token, payload={"ref": ref, "inputs": inputs})
    print(f"GitHub Workflow dispatch {url}: returned {status}")
    if status not in (200, 204):
        raise ValueError(
            f"github workflow dispatch failed: {status}: {data.get('message')}"
        )

    # The documented response is an empty 204, so the run has to be looked up.
    if data.get("run_url"):
        return data["run_url"]

    for _ in range(20):
        time.sleep(15)
        run = newest_run(base_url, token, workflow_id, ref)
        if run and run["id"] > previous_id:
            return run["url"]

    raise ValueError("github workflow dispatch did not produce a run")


def wait_for_run(run_url, token, poll_interval, timeout):
    """Poll `run_url` until the run completes, returning its final payload."""
    deadline = time.monotonic() + timeout
    while True:
        status, data = github_api(run_url, token)
        if status == 200:
            print(f"GitHub Workflow Run {run_url}: status {data['status']}")
            if data["status"] == "completed":
                return data
        elif status == 404:
            print(f"GitHub Workflow Run {run_url}: not yet available")
        else:
            raise ValueError(
                f"github workflow run failed: {status}: {data.get('message')}"
            )

        if time.monotonic() > deadline:
            raise TimeoutError(
                f"run did not complete within {timeout}s, see {data.get('html_url', run_url)}"
            )

        print(f"GitHub Workflow: wait {poll_interval}s")
        time.sleep(poll_interval)


def log_order(name):
    """Order "<index>_<job name>.txt" entries by their numeric index."""
    index = name.split("_", 1)[0]
    return (int(index) if index.isdigit() else -1, name)


def replay_logs(run_url, token, upload_dir):
    """Save the run's log archive next to the task artifacts and print it."""
    with open(os.path.join(upload_dir, "github_logs.txt"), "w") as log_link:
        log_link.write(f"{run_url}/logs")

    status, logs = github_api(f"{run_url}/logs", token, raw=True)
    if status != 200:
        raise ValueError(
            f"github workflow logs failed: {status}: "
            f"{logs[:512].decode('utf-8', 'replace')}"
        )

    with open(os.path.join(upload_dir, "github_logs.zip"), "wb") as zip_file:
        zip_file.write(logs)

    with zipfile.ZipFile(io.BytesIO(logs)) as archive:
        # The archive holds one text file per job at its top level, and the
        # same content split per step in a directory per job below that.
        entries = [name for name in archive.namelist() if name.endswith(".txt")]
        per_job = sorted(
            [name for name in entries if "/" not in name] or entries, key=log_order
        )
        for name in per_job:
            # Replayed line by line so the GitHub workflow output ends up in the
            # task log rather than in an artifact nobody thinks to open.
            print(f"===== GitHub Workflow log: {name} =====")
            print(archive.read(name).decode("utf-8", "replace"))


def main():
    # No argument defaults: every value is spelled out by the task, under the
    # `enterprise-end2end` key of taskcluster/kinds/test/enterprise-end2end.yml.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument(
        "--workflow", required=True, help="name of the active workflow to dispatch"
    )
    parser.add_argument(
        "--ref",
        required=True,
        choices=("main", "current", "minimal"),
        help="which console repository ref to dispatch on: its main branch, "
        "the tag of its latest release, or the oldest release Firefox still "
        f"supports (from {MIN_VERSION_FILE})",
    )
    parser.add_argument(
        "--affected-scopes",
        required=True,
        help="JSON array of scopes the workflow should exercise",
    )
    parser.add_argument("--upload-dir", required=True)
    parser.add_argument("--poll-interval", type=int, required=True)
    parser.add_argument(
        "--timeout",
        type=int,
        required=True,
        help="give up on the run after this many seconds, short enough to still "
        "collect its logs before the task hits max-run-time",
    )
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        parser.error("GITHUB_TOKEN is unset, run this through enterprise-end2end.sh")

    build_task = os.environ.get("UPSTREAM_TASKIDS")
    if not build_task:
        parser.error("UPSTREAM_TASKIDS is unset, there should be an upstream task ID")

    os.makedirs(args.upload_dir, exist_ok=True)
    print(f"GitHub Workflow against: {build_task}")

    repo_url = f"{GITHUB_API}/repos/{args.owner}/{args.repo}"
    base_url = f"{repo_url}/actions"
    ref = resolve_ref(args.ref, repo_url, token)
    workflow_id = find_workflow(base_url, token, args.workflow)
    run_url = dispatch(
        base_url,
        token,
        workflow_id,
        ref,
        {"fxe_task_id": build_task, "affected_scopes": args.affected_scopes},
    )
    print(f"GitHub Workflow Run: {run_url}")

    run = wait_for_run(run_url, token, args.poll_interval, args.timeout)

    # Fetch the logs before acting on the conclusion, so a failing run still
    # leaves them behind for debugging.
    replay_logs(run_url, token, args.upload_dir)

    conclusion = run["conclusion"]
    print(f"Enterprise End-to-end concluded: {conclusion}, see {run.get('html_url')}")
    return 0 if conclusion == "success" else 1


if __name__ == "__main__":
    sys.exit(main())
