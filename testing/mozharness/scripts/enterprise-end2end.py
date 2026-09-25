#!/usr/bin/env python
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this file,
# You can obtain one at http://mozilla.org/MPL/2.0/.

import io
import json
import os
import sys
import time
import zipfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen

# load modules from parent dir
sys.path.insert(1, os.path.dirname(sys.path[0]))

from mozharness.base.vcs.vcsbase import MercurialScript
from mozharness.mozilla.automation import (
    TBPL_FAILURE,
    TBPL_STATUS_DICT,
    TBPL_SUCCESS,
)
from mozharness.mozilla.secrets import SecretsMixin
from mozharness.mozilla.testing.testbase import TestingMixin


class EnterpriseEnd2EndTest(TestingMixin, MercurialScript, SecretsMixin):
    config_options = ()

    repos = []

    def __init__(self, require_config_file=False):
        super().__init__(
            config_options=self.config_options,
            all_actions=[
                "clobber",
                "get-secrets",
                "run-tests",
            ],
            default_actions=[
                "clobber",
                "get-secrets",
                "run-tests",
            ],
            require_config_file=require_config_file,
            config={"require_test_zip": True},
        )

    def query_abs_dirs(self):
        if self.abs_dirs:
            return self.abs_dirs
        abs_dirs = super().query_abs_dirs()
        dirs = {}
        dirs["abs_blob_upload_dir"] = os.path.join(
            abs_dirs["abs_work_dir"], "blobber_upload_dir"
        )

        for key in dirs.keys():
            if key not in abs_dirs:
                abs_dirs[key] = dirs[key]
        self.abs_dirs = abs_dirs
        return self.abs_dirs

    def github_api(self, url, headers, payload=None, raw=False):
        """Perform a GitHub API call, returning (status code, decoded body).

        With `raw`, the body is returned as bytes instead of being decoded as
        JSON: the log download endpoints redirect to an archive, so the body
        that comes back is not JSON at all.
        """
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers = dict(headers, **{"Content-Type": "application/json"})

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

    def run_tests(self):
        dirs = self.query_abs_dirs()

        raw_log_file = os.path.join(
            dirs["abs_blob_upload_dir"], "enterprise_end2end_raw.log"
        )
        error_summary_file = os.path.join(
            dirs["abs_blob_upload_dir"], "enterprise_end2end_errorsummary.log"
        )

        config_fmt_args = {
            "raw_log_file": raw_log_file,
            "error_summary_file": error_summary_file,
            "gecko_log": dirs["abs_blob_upload_dir"],
            "this_chunk": self.config.get("this_chunk", 1),
            "total_chunks": self.config.get("total_chunks", 1),
            "repo": self.config.get("repo"),
            "owner": self.config.get("owner"),
            "workflow_id": "EMPTY",
        }

        # python = self.query_python_path("python")
        # cmd = [python, "-u", os.path.join(dirs["abs_enterprise_end2end_dir"], "runtests.py")]

        if self.mkdir_p(dirs["abs_blob_upload_dir"]) == -1:
            # Make sure that the logging directory exists
            self.fatal("Could not create blobber upload directory")

        env = {}
        env["MOZ_UPLOAD_DIR"] = self.query_abs_dirs()["abs_blob_upload_dir"]

        if not os.path.isdir(env["MOZ_UPLOAD_DIR"]):
            self.mkdir_p(env["MOZ_UPLOAD_DIR"])

        env = self.query_env(partial_env=env)

        build_task = os.environ.get("UPSTREAM_TASKIDS", None)
        assert build_task, "There should be an upstream task ID"

        self.log(f"GitHub Workflow against: {build_task}")

        token = None
        with open("enterprise-console-backend-apitoken") as token_file:
            token = token_file.read().strip()

        base_url = (
            "https://api.github.com/repos/%(owner)s/%(repo)s/actions" % config_fmt_args
        )
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2026-03-10",
        }

        workflows_url = f"{base_url}/workflows"
        self.log(f"GitHub Workflows URL: {workflows_url}")
        status_code, data = self.github_api(workflows_url, headers)
        if status_code != 200:
            self.log(f"GitHub Workflow list failed: {data.get('message')}")
            raise ValueError(f"github workflow list failed: {status_code}")
        self.log(f"GitHub Workflows URL: {workflows_url}: returned {status_code}")

        config_fmt_args["workflow_id"] = next(
            w
            for w in data["workflows"]
            if w["state"] == "active" and w["name"] == "Test"
        )["id"]

        dispatches_url = (
            base_url + "/workflows/%(workflow_id)s/dispatches" % config_fmt_args
        )
        payload = {
            "ref": "main",
            "inputs": {
                "fxe_task_id": f"{build_task}",
                "affected_scopes": json.dumps('["e2e"]'),
            },
        }

        self.log(
            f"GitHub Workflow Dispatches: {dispatches_url}: returned {status_code}"
        )
        status_code, data = self.github_api(dispatches_url, headers, payload=payload)
        if status_code != 200:
            self.log(f"GitHub Workflow dispatch failed: {data.get('message')}")
            raise ValueError(f"github workflow dispatch failed: {status_code}")
        self.log(
            f"GitHub Workflow Dispatches: {dispatches_url}: returned {status_code}"
        )

        run_url = data["run_url"]
        self.log(f"GitHub Workflow Run: {run_url}")

        return_code = 1
        while True:
            status_code, data = self.github_api(run_url, headers)
            self.log(f"GitHub Workflow Run: {run_url}: status {data['status']}")

            if data["status"] == "completed":  # adjust condition as needed
                return_code = 0 if data["conclusion"] == "success" else 1
                break

            self.log("GitHub Workflow: wait 30s")
            time.sleep(30)

        raw_log_link = os.path.join(dirs["abs_blob_upload_dir"], "github_logs.txt")
        with open(raw_log_link, "w") as log_link:
            log_link.write(f"{run_url}/logs")

        status_code, logs = self.github_api(f"{run_url}/logs", headers, raw=True)
        if status_code != 200:
            self.log(
                f"GitHub Workflow logs failed: {logs[:512].decode('utf-8', 'replace')}"
            )
            raise ValueError(f"github workflow logs failed: {status_code}")

        logs_zip_file = os.path.join(dirs["abs_blob_upload_dir"], "github_logs.zip")
        with open(logs_zip_file, "wb") as zip_file:
            zip_file.write(logs)

        def log_order(name):
            """Order "<index>_<job name>.txt" entries by their numeric index."""
            index = name.split("_", 1)[0]
            return (int(index) if index.isdigit() else -1, name)

        with zipfile.ZipFile(io.BytesIO(logs)) as archive:
            # The archive holds one text file per job at its top level, and the
            # same content split per step in a directory per job below that.
            entries = [name for name in archive.namelist() if name.endswith(".txt")]
            per_job = sorted(
                [name for name in entries if "/" not in name] or entries, key=log_order
            )
            for name in per_job:
                # Replayed line by line by the logger, so the GitHub workflow
                # output ends up in the task log rather than in an artifact
                # nobody thinks to open.
                self.log(f"===== GitHub Workflow log: {name} =====")
                self.log(archive.read(name).decode("utf-8", "replace"))

        # The work happens in the GitHub workflow, so its conclusion is the
        # whole result: there is no local output for an output parser to read,
        # and `evaluate_parser` would call every run a failure for want of a
        # `passed: N` line to count.
        tbpl_status = TBPL_SUCCESS if return_code == 0 else TBPL_FAILURE
        log_level = TBPL_STATUS_DICT[tbpl_status]

        self.log(
            "Enterprise End-to-end exited with return code %s: %s"
            % (return_code, tbpl_status),
            level=log_level,
        )
        self.record_status(tbpl_status, level=log_level)


if __name__ == "__main__":
    enterpriseEnd2EndTest = EnterpriseEnd2EndTest()
    enterpriseEnd2EndTest.run_and_exit()
