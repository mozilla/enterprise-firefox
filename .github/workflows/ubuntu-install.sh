#!/bin/bash

apt -y update && sudo apt -y upgrade
apt -y install \
        build-essential \
        curl \
        git \
        libc6-i386 \
        libasound2-dev \
        libdbus-glib-1-dev \
        libgtk2.0-dev \
        libgtk-3-dev \
        libpython3-dev \
        libx11-xcb-dev \
        libxt-dev \
        msitools \
        make \
        patch \
        patchelf \
        python3-dev \
        python3-yaml \
        python3-venv \
        rsync \
        squashfs-tools \
        tar \
        unzip \
        uuid \
        wget \
        xattr \
        zip \
        7zip

export RUSTUP_HOME=/usr/local
export CARGO_HOME=/usr/local 
curl \
	--proto '=https' --tlsv1.2 -sSf \
	https://sh.rustup.rs | sh -s -- -y

rustup target add x86_64-unknown-linux-gnu
rustup target add x86_64-pc-windows-msvc
rustup target add aarch64-apple-darwin
rustup toolchain install 1.89

# mach macos-sign will perform a verify step that depends on codesign
cargo install apple-codesign
ln -s /usr/bin/true /usr/bin/codesign

rcodesign --version

useradd worker -d /home/worker
mkdir -p /home/worker
chown worker:worker /home/worker

sudo -u worker mkdir /home/worker/actions-runner
sudo -u worker sh -c "cd /home/worker/actions-runner && curl -o actions-runner-linux-x64-2.328.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.328.0/actions-runner-linux-x64-2.328.0.tar.gz && tar xf actions-runner-linux-x64-2.328.0.tar.gz"

poweroff
