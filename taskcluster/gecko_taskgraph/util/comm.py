# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import logging
import os

from taskgraph.util.yaml import load_yaml

from gecko_taskgraph import GECKO

logger = logging.getLogger(__name__)

COMM_REPOSITORY = "https://github.com/thunderbird/thunderbird-desktop"
COMM_ROOT = os.path.join(GECKO, "comm", "taskcluster")
COMM_REV_FILE = os.path.join(GECKO, "taskcluster", "comm_rev.yml")

# Gecko project to the project of the Thunderbird graph it schedules.
COMM_PROJECTS = {
    "enterprise-firefox": "enterprise-thunderbird",
    "enterprise-firefox-try": "enterprise-thunderbird-try",
}

# enterprise-firefox branch to the thunderbird-desktop one it builds with.
COMM_BRANCHES = {
    "enterprise-main": "main",
    "enterprise-beta": "beta",
    "enterprise-release": "release",
}

COMM_TASKS_FOR = {
    "github-push",
    "github-pull-request",
    "github-pull-request-untrusted",
}


def _short_ref(ref):
    return (ref or "").removeprefix("refs/heads/")


def get_comm_branch(parameters):
    """enterprise-firefox branch whose pinned thunderbird-desktop revision to use."""
    if parameters["project"] != "enterprise-firefox-try":
        for ref in (parameters.get("head_ref"), parameters.get("base_ref")):
            if _short_ref(ref) in COMM_BRANCHES:
                return _short_ref(ref)
    return "enterprise-main"


def get_comm_ref(parameters):
    return f"refs/heads/{COMM_BRANCHES[get_comm_branch(parameters)]}"


def get_pinned_rev(branch):
    return load_yaml(COMM_REV_FILE)[branch]


def get_comm_checkout(parameters):
    """Thunderbird checkout to schedule along a Gecko push, or None.

    The revision is pinned in taskcluster/comm_rev.yml rather than in
    .taskcluster.yml, and reaches the comm-decision action through the
    actions.json of the decision task."""
    if (
        parameters["repository_type"] != "git"
        or parameters["project"] not in COMM_PROJECTS
        or parameters["tasks_for"] not in COMM_TASKS_FOR
    ):
        return None

    ref = get_comm_ref(parameters)
    rev = get_pinned_rev(get_comm_branch(parameters))
    logger.info(f"Using {COMM_REPOSITORY} {ref} pinned at {rev}")
    return {
        "base_repository": COMM_REPOSITORY,
        "base_ref": ref,
        "base_rev": rev,
        "head_repository": COMM_REPOSITORY,
        "head_ref": ref,
        "head_rev": rev,
    }
