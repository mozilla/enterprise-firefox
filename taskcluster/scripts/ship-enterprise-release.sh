#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Ship a Firefox Enterprise OCI release by tagging the digest that the push task
# staged. No blobs are re-uploaded; this is a manifest-only retag, so it ships
# exactly the image that was staged and verified.
#
# Consumes the `release-index.txt` handoff produced by the upstream
# `enterprise-release-push` task and the prebuilt `moa` binary, both in
# $MOZ_FETCHES_DIR, then runs `moa tag`.
#
# Registry credentials are read from a Taskcluster secret (via the
# taskcluster-proxy) and written to a `.env` file, which `moa` loads with dotenv.
#
# Required environment:
#   REGISTRY_SECRET       Taskcluster secret holding registry credentials. Its
#                         `content` is the dotenv body verbatim, so this script
#                         never has to know which credentials it carries.
#   MOZ_FETCHES_DIR       Set by run-task; contains `moa` and
#                         `release-index.json`.
#   TASKCLUSTER_PROXY_URL Set when the task enables the taskcluster proxy.
set -xe
set -o pipefail

: "${REGISTRY_SECRET:?REGISTRY_SECRET must be set}"
: "${MOZ_FETCHES_DIR:?MOZ_FETCHES_DIR must be set}"
: "${TASKCLUSTER_PROXY_URL:?TASKCLUSTER_PROXY_URL must be set (enable the taskcluster proxy)}"

moa="${MOZ_FETCHES_DIR}/moa"
index_file="${MOZ_FETCHES_DIR}/release-index.json"

chmod +x "${moa}"

# Fetch the .env `moa` reads via dotenv. The secret stores it ready to use;
# the only work left is unwrapping the {"secret": ..., "expires": ...} envelope
# the secrets API responds with.
curl -sSf "${TASKCLUSTER_PROXY_URL%/}/secrets/v1/secret/${REGISTRY_SECRET}" |
    python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin)["secret"]["content"])' \
    > .env

# Read the staged reference, channel and digest from the push task's handoff.
read -r index channel < <(
    python3 -c 'import json,sys; j=json.load(sys.stdin); sys.stdout.write(j["index"] + " " + j["channel"])' < "${index_file}"
)

"${moa}" tag "${index}" "${channel}"
