#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Ship a Firefox Enterprise OCI release by tagging the digest that the push task
# staged. No blobs are re-uploaded; this is a manifest-only retag, so it ships
# exactly the image that was staged and verified.
#
# Consumes the `release-index.json` handoff produced by the upstream
# `enterprise-release-push` task ({reference, channel, index_digest}) and the
# prebuilt `moa` binary, both in $MOZ_FETCHES_DIR, then runs `moa tag`.
#
# Registry credentials are read from a Taskcluster secret (via the
# taskcluster-proxy) and written to a `.env` file, which `moa` loads with dotenv.
#
# Required environment:
#   REGISTRY_SECRET       Taskcluster secret name holding registry credentials.
#                         Expected keys: either `bearer_token`, or both
#                         `username` and `password`.
#   MOZ_FETCHES_DIR       Set by run-task; contains `moa` and
#                         `release-index.json`.
#   TASKCLUSTER_PROXY_URL Set when the task enables the taskcluster proxy.
set -xe

: "${REGISTRY_SECRET:?REGISTRY_SECRET must be set}"
: "${MOZ_FETCHES_DIR:?MOZ_FETCHES_DIR must be set}"
: "${TASKCLUSTER_PROXY_URL:?TASKCLUSTER_PROXY_URL must be set (enable the taskcluster proxy)}"

moa="${MOZ_FETCHES_DIR}/moa"
index="${MOZ_FETCHES_DIR}/release-index.json"

chmod +x "${moa}"

# Fetch registry credentials from the Taskcluster secret into a .env file that
# `moa` reads via dotenv. Uses only the Python standard library so it works in
# any image with python3.
python3 - "${REGISTRY_SECRET}" > .env <<'PY'
import json
import os
import sys
import urllib.request

name = sys.argv[1]
proxy = os.environ["TASKCLUSTER_PROXY_URL"].rstrip("/")
url = f"{proxy}/secrets/v1/secret/{name}"
with urllib.request.urlopen(url) as resp:
    secret = json.load(resp)["secret"]

lines = []
if secret.get("bearer_token"):
    lines.append(f"REGISTRY_BEARER_TOKEN={secret['bearer_token']}")
else:
    lines.append(f"REGISTRY_USERNAME={secret['username']}")
    lines.append(f"REGISTRY_PASSWORD={secret['password']}")
sys.stdout.write("\n".join(lines) + "\n")
PY

# Read the staged reference, channel and digest from the push task's handoff.
read -r reference channel digest < <(
    python3 - "${index}" <<'PY'
import json
import sys

with open(sys.argv[1]) as fh:
    data = json.load(fh)
print(data["reference"], data["channel"], data["index_digest"])
PY
)

# TODO: requires moa support for a `tag` subcommand that points an existing
# index digest at a tag (the release channel) without re-uploading blobs.
"${moa}" tag "${reference}" "${digest}" "${channel}"
