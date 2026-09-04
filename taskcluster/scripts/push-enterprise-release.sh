#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Stage a Firefox Enterprise OCI release in the registry, addressed by digest.
#
# Consumes the `release-definition.json` produced by an upstream
# `enterprise-release-definition` task and the prebuilt `moa` binary, both in
# $MOZ_FETCHES_DIR, then runs `moa push release --no-tag`. This uploads all
# blobs, per-variant manifests, the release index and referrers WITHOUT applying
# the release-channel tag. The resulting OCI index digest is written to
# `release-index.json` and handed off to the ship task, which tags that digest.
#
# Registry credentials are read from a Taskcluster secret (via the
# taskcluster-proxy) and written to a `.env` file, which `moa` loads with dotenv.
#
# Required environment:
#   REGISTRY_REFERENCE    OCI reference (registry/repo, no tag).
#   REGISTRY_SECRET       Taskcluster secret name holding registry credentials.
#                         Expected keys: either `bearer_token`, or both
#                         `username` and `password`.
#   MOZ_FETCHES_DIR       Set by run-task; contains `moa` and
#                         `release-definition.json`.
#   TASKCLUSTER_PROXY_URL Set when the task enables the taskcluster proxy.
set -xe

: "${REGISTRY_REFERENCE:?REGISTRY_REFERENCE must be set}"
: "${REGISTRY_SECRET:?REGISTRY_SECRET must be set}"
: "${MOZ_FETCHES_DIR:?MOZ_FETCHES_DIR must be set}"
: "${TASKCLUSTER_PROXY_URL:?TASKCLUSTER_PROXY_URL must be set (enable the taskcluster proxy)}"

moa="${MOZ_FETCHES_DIR}/moa"
definition="${MOZ_FETCHES_DIR}/release-definition.json"
output="/builds/worker/artifacts/release-index.json"

mkdir -p "$(dirname "${output}")"
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

# TODO: requires moa support for `--no-tag` (push without applying the channel
# tag) and `--output` (write {reference, channel, index_digest} as JSON). The
# ship task consumes that file and tags the digest with the channel.
"${moa}" push release \
    --format oci-release \
    --no-tag \
    --output "${output}" \
    "${REGISTRY_REFERENCE}" \
    "${definition}"

cat "${output}"
