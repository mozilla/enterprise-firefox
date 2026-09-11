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
# `release-index.txt` and handed off to the ship task, which tags that digest.
#
# Registry credentials are read from a Taskcluster secret (via the
# taskcluster-proxy) and written to a `.env` file, which `moa` loads with dotenv.
#
# Required environment:
#   REGISTRY_REFERENCE    OCI reference (registry/repo, no tag).
#   REGISTRY_SECRET       Taskcluster secret holding registry credentials. Its
#                         `content` is the dotenv body verbatim, so this script
#                         never has to know which credentials it carries.
#   MOZ_FETCHES_DIR       Set by run-task; contains `moa` and
#                         `release-definition.json`.
#   TASKCLUSTER_PROXY_URL Set when the task enables the taskcluster proxy.
set -xe
set -o pipefail

: "${REGISTRY_REFERENCE:?REGISTRY_REFERENCE must be set}"
: "${REGISTRY_SECRET:?REGISTRY_SECRET must be set}"
: "${MOZ_FETCHES_DIR:?MOZ_FETCHES_DIR must be set}"
: "${TASKCLUSTER_PROXY_URL:?TASKCLUSTER_PROXY_URL must be set (enable the taskcluster proxy)}"

moa="${MOZ_FETCHES_DIR}/mozilla-oci-artifacts-cli/moa"
definition="${MOZ_FETCHES_DIR}/release-definition.json"
output="/builds/worker/artifacts/release-index.json"

mkdir -p "$(dirname "${output}")"

# Fetch the .env `moa` reads via dotenv. The secret stores it ready to use;
# the only work left is unwrapping the {"secret": ..., "expires": ...} envelope
# the secrets API responds with.
curl -sSf "${TASKCLUSTER_PROXY_URL%/}/secrets/v1/secret/${REGISTRY_SECRET}" |
    python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin)["secret"]["content"])' \
    > .env

index=$("${moa}" push release \
    --concurrency 1 \
    --no-tag \
    "${REGISTRY_REFERENCE}" \
    "${definition}")

channel=$(python3 -c \
    'import json,sys; sys.stdout.write(json.load(sys.stdin)["channel"])' \
    < "${definition}")

python3 -c \
    'import json,sys; sys.stdout.write(json.dumps({"index": sys.argv[1], "channel": sys.argv[2]}))' \
    "${index}" "${channel}"
