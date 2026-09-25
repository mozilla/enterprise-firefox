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

    def test_unknown(self):
        context = {"tasks_for": "bitkeeper-push"}
        rendered = jsone.render(self.taskcluster_yml, context)
        pprint.pprint(rendered)
        self.assertEqual(rendered["tasks"], [])


COMM_ROOT = "comm/taskcluster"
COMM_CHECKOUT = "--comm-checkout=/builds/worker/checkouts/gecko/comm"


class TestCommGraphForwarding(unittest.TestCase):
    """The Thunderbird graph an enterprise push also builds, and its actions.

    See ``gecko_taskgraph.actions.forward_comm``: the Firefox Enterprise
    decision task records how to reach the Thunderbird decision task, and an
    action carrying that back is rendered against the Thunderbird graph rather
    than this one.
    """

    @property
    def taskcluster_yml(self):
        return load_yaml(GECKO, ".taskcluster.yml")

    def render(self, context):
        # `as_slugid` is memoized per name within one render, as
        # taskcluster-github does it, so the two decision tasks agree on the
        # id of the Thunderbird one.
        slugids = {}
        context = dict(
            context, as_slugid=lambda name: slugids.setdefault(name, slugid.nice())
        )
        return jsone.render(self.taskcluster_yml, context)

    def push_context(self):
        return {
            "tasks_for": "github-push",
            "event": {
                "repository": {
                    "html_url": "https://github.com/mozilla/enterprise-firefox",
                    "name": "enterprise-firefox",
                },
                "ref": "refs/heads/enterprise-main",
                "before": "9bc0eecb0d5950097c538b5487c00782284749fe",
                "after": "0136d2b956f830b8b3a44db941437c0e66b5a5f1",
                "pusher": {"email": "someone@users.noreply.github.com"},
            },
            "now": current_json_time(),
            "ownTaskId": slugid.nice(),
            "taskId": None,
        }

    def action_context(self, parameters):
        return {
            "tasks_for": "action",
            "repository": {
                "url": "https://github.com/mozilla/enterprise-firefox",
                "project": "enterprise-firefox",
                "level": 3,
            },
            "push": {
                "revision": "0136d2b956f830b8b3a44db941437c0e66b5a5f1",
                "base_revision": "9bc0eecb0d5950097c538b5487c00782284749fe",
                "owner": "someone@users.noreply.github.com",
                "pushlog_id": 0,
                "branch": "refs/heads/enterprise-main",
            },
            "action": {
                "name": "release-promotion-comm",
                "title": "Thunderbird Release Promotion",
                "description": "Just testing",
                "taskGroupId": slugid.nice(),
                "symbol": "t",
                "repo_scope": (
                    "assume:repo:github.com/mozilla/enterprise-firefox"
                    ":action:release-promotion"
                ),
                "cb_name": "comm-release-promotion",
                "action_perm": "release-promotion",
            },
            "input": {},
            "parameters": parameters,
            "now": current_json_time(),
            "taskId": None,
            "ownTaskId": slugid.nice(),
            "clientId": "testing/testing/testing",
        }

    def test_push_records_comm_graph(self):
        """The decision records the same comm checkout it hands the comm decision.

        Both descriptions are spelled out in `.taskcluster.yml`; this is what
        catches them drifting apart.
        """
        rendered = self.render(self.push_context())
        gecko, comm = rendered["tasks"]
        self.assertEqual(gecko["metadata"]["name"], "Decision Task (push)")
        self.assertEqual(comm["metadata"]["name"], "Comm Decision Task (push)")

        gecko_env = gecko["payload"]["env"]
        comm_env = comm["payload"]["env"]
        self.assertEqual(gecko_env["COMM_DECISION_TASK_ID"], comm["taskId"])
        for var in ("COMM_HEAD_REPOSITORY", "COMM_HEAD_REF", "COMM_HEAD_REV"):
            self.assertEqual(gecko_env[var], comm_env[var])

        # The decision itself never reads the Thunderbird tree.
        self.assertNotIn(COMM_CHECKOUT, gecko["payload"]["command"])

    def test_action_forwarded_to_comm_graph(self):
        comm_graph = {
            "task_id": slugid.nice(),
            "root": COMM_ROOT,
            "head_repository": "https://github.com/thunderbird/thunderbird-desktop",
            "head_ref": "refs/heads/main",
            "head_rev": "c0e398ed8f055a7f2e5cadecb1513a6d8708107b",
        }
        context = self.action_context({
            "repository_type": "git",
            "comm_graph": comm_graph,
        })
        # Only tasks[0] is reachable: that is what the action hook renders.
        task = self.render(context)["tasks"][0]
        env = task["payload"]["env"]
        command = task["payload"]["command"]

        self.assertEqual(
            task["metadata"]["name"], "Action: Thunderbird Release Promotion"
        )
        # Parameters are fetched from the task group named here, so this is
        # what decides which graph the callback acts on.
        self.assertEqual(env["ACTION_TASK_GROUP_ID"], comm_graph["task_id"])
        self.assertEqual(env["COMM_HEAD_REV"], comm_graph["head_rev"])
        self.assertIn(COMM_CHECKOUT, command)
        self.assertIn(f"action-callback --root={COMM_ROOT}", command[-1])
        # The Thunderbird graph is built in the enterprise trust domain, as it
        # is for the comm decision task.
        self.assertIn("trust-domain: enterprise", command[-1])

    def test_action_not_forwarded(self):
        context = self.action_context({"repository_type": "git"})
        task = self.render(context)["tasks"][0]
        env = task["payload"]["env"]
        command = task["payload"]["command"]

        self.assertEqual(env["ACTION_TASK_GROUP_ID"], context["action"]["taskGroupId"])
        self.assertNotIn("COMM_HEAD_REV", env)
        self.assertNotIn(COMM_CHECKOUT, command)
        self.assertNotIn("--root=", command[-1])


if __name__ == "__main__":
    main()
