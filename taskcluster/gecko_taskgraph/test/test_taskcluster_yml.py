# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import pprint
import unittest

import jsone
import slugid
from mozunit import main
from taskgraph.util.time import current_json_time
from taskgraph.util.yaml import load_yaml

from gecko_taskgraph import GECKO


class TestTaskclusterYml(unittest.TestCase):
    @property
    def taskcluster_yml(self):
        return load_yaml(GECKO, ".taskcluster.yml")

    def test_push(self):
        context = {
            "tasks_for": "hg-push",
            "push": {
                "revision": "e8d2d9aff5026ef1f1777b781b47fdcbdb9d8f20",
                "base_revision": "e8aebe488b2f2e567940577de25013d00e818f7c",
                "owner": "dustin@mozilla.com",
                "pushlog_id": 1556565286,
                "pushdate": 112957,
            },
            "repository": {
                "url": "https://hg.mozilla.org/mozilla-central",
                "project": "mozilla-central",
                "level": "3",
                "type": "hg",
            },
            "ownTaskId": slugid.nice(),
        }
        rendered = jsone.render(self.taskcluster_yml, context)
        pprint.pprint(rendered)
        self.assertEqual(
            rendered["tasks"][0]["metadata"]["name"], "Gecko Decision Task"
        )
        self.assertIn("matrixBody", rendered["tasks"][0]["extra"]["notify"])

    def test_push_non_mc(self):
        context = {
            "tasks_for": "hg-push",
            "push": {
                "revision": "e8d2d9aff5026ef1f1777b781b47fdcbdb9d8f20",
                "base_revision": "e8aebe488b2f2e567940577de25013d00e818f7c",
                "owner": "dustin@mozilla.com",
                "pushlog_id": 1556565286,
                "pushdate": 112957,
            },
            "repository": {
                "url": "https://hg.mozilla.org/releases/mozilla-beta",
                "project": "mozilla-beta",
                "level": "3",
                "type": "hg",
            },
            "ownTaskId": slugid.nice(),
        }
        rendered = jsone.render(self.taskcluster_yml, context)
        pprint.pprint(rendered)
        self.assertEqual(
            rendered["tasks"][0]["metadata"]["name"], "Gecko Decision Task"
        )
        self.assertNotIn("matrixBody", rendered["tasks"][0]["extra"]["notify"])

    def test_cron(self):
        context = {
            "tasks_for": "cron",
            "repository": {
                "url": "https://hg.mozilla.org/mozilla-central",
                "project": "mozilla-central",
                "level": 3,
                "type": "hg",
            },
            "push": {
                "revision": "e8aebe488b2f2e567940577de25013d00e818f7c",
                "base_revision": "54cbb3745cdb9a8aa0a4428d405b3b2e1c7d13c2",
                "pushlog_id": -1,
                "pushdate": 0,
                "owner": "cron",
            },
            "cron": {
                "task_id": "<cron task id>",
                "job_name": "test",
                "job_symbol": "T",
                "quoted_args": "abc def",
            },
            "now": current_json_time(),
            "ownTaskId": slugid.nice(),
        }
        rendered = jsone.render(self.taskcluster_yml, context)
        pprint.pprint(rendered)
        self.assertEqual(
            rendered["tasks"][0]["metadata"]["name"], "Decision Task for cron job test"
        )

    def test_action(self):
        context = {
            "tasks_for": "action",
            "repository": {
                "url": "https://hg.mozilla.org/mozilla-central",
                "project": "mozilla-central",
                "level": 3,
            },
            "push": {
                "revision": "e8d2d9aff5026ef1f1777b781b47fdcbdb9d8f20",
                "base_revision": "e8aebe488b2f2e567940577de25013d00e818f7c",
                "owner": "dustin@mozilla.com",
                "pushlog_id": 1556565286,
                "pushdate": 112957,
            },
            "action": {
                "name": "test-action",
                "title": "Test Action",
                "description": "Just testing",
                "taskGroupId": slugid.nice(),
                "symbol": "t",
                "repo_scope": "assume:repo:hg.mozilla.org/try:action:generic",
                "cb_name": "test_action",
            },
            "input": {},
            "parameters": {
                "repository_type": "hg",
            },
            "now": current_json_time(),
            "taskId": slugid.nice(),
            "ownTaskId": slugid.nice(),
            "clientId": "testing/testing/testing",
        }
        rendered = jsone.render(self.taskcluster_yml, context)
        pprint.pprint(rendered)
        self.assertEqual(
            rendered["tasks"][0]["metadata"]["name"], "Action: Test Action"
        )

    def test_github_push(self):
        context = {
            "tasks_for": "github-push",
            "event": {
                "after": "e8d2d9aff5026ef1f1777b781b47fdcbdb9d8f20",
                "before": "e8aebe488b2f2e567940577de25013d00e818f7c",
                "ref": "refs/heads/enterprise-main",
                "pusher": {"email": "someone@mozilla.com"},
                "repository": {
                    "html_url": "https://github.com/mozilla/enterprise-firefox",
                    "name": "enterprise-firefox",
                },
            },
            "now": current_json_time(),
            "as_slugid": lambda x: slugid.nice(),
        }
        rendered = jsone.render(self.taskcluster_yml, context)
        pprint.pprint(rendered)
        self.assertEqual(len(rendered["tasks"]), 1)
        task = rendered["tasks"][0]
        self.assertEqual(task["schedulerId"], "enterprise-level-3")
        self.assertTrue(
            task["metadata"]["source"].startswith(
                "https://github.com/mozilla/enterprise-firefox/raw/"
            )
        )
        self.assertNotIn("COMM_HEAD_REV", task["payload"]["env"])

    def _git_action_context(self, parameters):
        return {
            "tasks_for": "action",
            "repository": {
                "url": "https://github.com/mozilla/enterprise-firefox",
                "project": "enterprise-firefox",
                "level": "3",
                "base_url": "https://github.com/mozilla/enterprise-firefox",
            },
            "push": {
                "revision": "e8d2d9aff5026ef1f1777b781b47fdcbdb9d8f20",
                "base_revision": "e8aebe488b2f2e567940577de25013d00e818f7c",
                "owner": "mozilla-taskcluster-maintenance@mozilla.com",
                "pushlog_id": "0",
                "branch": "refs/heads/enterprise-main",
            },
            "action": {
                "name": "test-action",
                "title": "Test Action",
                "description": "Just testing",
                "taskGroupId": slugid.nice(),
                "symbol": "t",
                "repo_scope": "assume:repo:github.com/mozilla/enterprise-firefox:action:generic",
                "action_perm": "generic",
                "cb_name": "test_action",
            },
            "input": {},
            "parameters": parameters,
            "now": current_json_time(),
            "taskId": None,
            "ownTaskId": slugid.nice(),
            "clientId": "testing/testing/testing",
        }

    COMM = {
        "base_repository": "https://github.com/thunderbird/thunderbird-desktop",
        "base_rev": "718b4b4559717aa5d11304c7ea58901c3e8f9aac",
        "head_repository": "https://github.com/thunderbird/thunderbird-desktop",
        "head_ref": "refs/heads/main",
        "head_rev": "718b4b4559717aa5d11304c7ea58901c3e8f9aac",
    }

    def test_git_action(self):
        context = self._git_action_context({"repository_type": "git"})
        rendered = jsone.render(self.taskcluster_yml, context)
        pprint.pprint(rendered)
        task = rendered["tasks"][0]
        self.assertEqual(task["metadata"]["name"], "Action: Test Action")
        self.assertNotIn("THUNDERBIRD_HEAD_REPOSITORY", task["payload"]["env"])
        self.assertNotIn(
            "--thunderbird-checkout=/builds/worker/checkouts/gecko/comm",
            task["payload"]["command"],
        )
        self.assertNotIn("comm/taskcluster", task["payload"]["command"][-1])

    def test_git_action_comm_checkout(self):
        context = self._git_action_context({
            "repository_type": "git",
            "comm": self.COMM,
        })
        rendered = jsone.render(self.taskcluster_yml, context)
        pprint.pprint(rendered)
        task = rendered["tasks"][0]
        env = task["payload"]["env"]
        self.assertEqual(env["THUNDERBIRD_HEAD_REV"], self.COMM["head_rev"])
        self.assertNotIn("COMM_HEAD_REPOSITORY", env)
        self.assertIn("thunderbird", env["REPOSITORIES"])
        self.assertIn(
            "--thunderbird-checkout=/builds/worker/checkouts/gecko/comm",
            task["payload"]["command"],
        )
        command = task["payload"]["command"][-1]
        self.assertIn("trust-domain: enterprise", command)
        self.assertNotIn("--root", command)

    def test_git_action_comm_root(self):
        context = self._git_action_context({
            "repository_type": "git",
            "comm": dict(self.COMM, root="comm/taskcluster"),
        })
        rendered = jsone.render(self.taskcluster_yml, context)
        pprint.pprint(rendered)
        command = rendered["tasks"][0]["payload"]["command"][-1]
        self.assertIn("taskgraph action-callback --root=comm/taskcluster", command)

    def test_unknown(self):
        context = {"tasks_for": "bitkeeper-push"}
        rendered = jsone.render(self.taskcluster_yml, context)
        pprint.pprint(rendered)
        self.assertEqual(rendered["tasks"], [])


if __name__ == "__main__":
    main()
