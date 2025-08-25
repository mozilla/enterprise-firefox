#!/bin/bash

KIND=$1

if [ -z "${KIND}" ]; then
    echo "Usage: $0 kind"
    exit 1
fi;

set -x

UBUNTU_VERSION=2404-noble-amd64-v20250818
SOURCE_IMAGE=projects/ubuntu-os-cloud/global/images/ubuntu-minimal-${UBUNTU_VERSION}
INSTANCE_NAME=linux-vm-${KIND}

gcloud compute instances create ${INSTANCE_NAME} \
    --project=enterprise-gha-runners \
    --zone=europe-west1-b \
    --machine-type=c4d-standard-96 \
    --network-interface=network-tier=STANDARD,nic-type=GVNIC,stack-type=IPV4_ONLY,subnet=enterprise-gha-runners \
    --metadata-from-file=startup-script=./ubuntu-install.sh \
    --no-restart-on-failure \
    --maintenance-policy=TERMINATE \
    --provisioning-model=SPOT \
    --instance-termination-action=DELETE \
    --max-run-duration=7200s \
    --service-account=firefox-enterprise-gha-runners@enterprise-gha-runners.iam.gserviceaccount.com \
    --scopes=https://www.googleapis.com/auth/devstorage.read_only,https://www.googleapis.com/auth/logging.write,https://www.googleapis.com/auth/monitoring.write,https://www.googleapis.com/auth/service.management.readonly,https://www.googleapis.com/auth/servicecontrol,https://www.googleapis.com/auth/trace.append \
    --create-disk=auto-delete=yes,boot=yes,device-name=${INSTANCE_NAME},image=$SOURCE_IMAGE,mode=rw,provisioned-iops=3480,provisioned-throughput=260,size=80,type=hyperdisk-balanced \
    --no-shielded-secure-boot \
    --shielded-vtpm \
    --shielded-integrity-monitoring \
    --labels=goog-ec-src=vm_add-gcloud \
    --reservation-affinity=none

VM_STATUS="RUNNING"
while [ "$VM_STATUS" = "RUNNING" ]
do
    echo "Sleeping 30s" && sleep 30
    VM_STATUS=$(gcloud compute instances list | grep ${INSTANCE_NAME} | awk '{ print $7 }')
    echo "VM: ${VM_STATUS}"
done;

DISK_DATE=$(date +%Y%m%d%H%M%S)
gcloud compute images create disk-${UBUNTU_VERSION}-${DISK_DATE} \
    --project=enterprise-gha-runners \
    --source-disk=${INSTANCE_NAME} \
    --source-disk-zone=europe-west1-b \
    --storage-location=europe-west1 \
    --force

yes | gcloud compute instances delete ${INSTANCE_NAME} --delete-disks=all --zone=europe-west1-b
