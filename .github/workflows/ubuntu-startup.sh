#!/bin/bash

sudo -u worker sh -c "cd /home/worker/actions-runner && ./config.sh --unattended --ephemeral --replace --name ##GH_INSTANCE_NAME## --labels ##GH_LABELS## --url ##GH_REPO_URL## --token ##GH_RUNNER_TOKEN##"

cd /home/worker/actions-runner
sudo ./svc.sh install worker
sudo ./svc.sh start
