#!/bin/bash
set -x -e -v

# This script is for building mold on Linux.

WORKSPACE=$HOME/workspace

sysroot=$MOZ_FETCHES_DIR/sysroot

PATH="$MOZ_FETCHES_DIR/rustc/bin:$MOZ_FETCHES_DIR/clang/bin:$PATH"
export CC=$MOZ_FETCHES_DIR/clang/bin/clang
export CXX=$MOZ_FETCHES_DIR/clang/bin/clang++
export CFLAGS_x86_64_unknown_linux_gnu="--sysroot=$sysroot -fuse-ld=lld -Wno-unused-command-line-argument"
export CXXFLAGS_x86_64_unknown_linux_gnu="-D_GLIBCXX_USE_CXX11_ABI=0 --sysroot=$sysroot -fuse-ld=lld -Wno-unused-command-line-argument"
export RUSTFLAGS="-Clinker=$CC -C link-arg=--sysroot=$sysroot -C link-arg=-fuse-ld=lld"
export CARGO_PROFILE_RELEASE_LTO=fat
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
export PKG_CONFIG_ALLOW_CROSS=1
export PKG_CONFIG_SYSROOT_DIR=$sysroot
export PKG_CONFIG_LIBDIR="$sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:$sysroot/usr/lib/pkgconfig:$sysroot/usr/share/pkgconfig"

cd $MOZ_FETCHES_DIR/mold

# https://github.com/rui314/mold/issues/1762
patch -p1 < $GECKO_PATH/taskcluster/scripts/misc/mold-icf-symtab.patch

# Only build the backends for the architectures we target on Linux.
cargo build \
  --locked \
  --verbose \
  --release \
  --package mold-cli \
  --no-default-features \
  --features x86_64,i386,arm64 \
  --target x86_64-unknown-linux-gnu \
  --target-dir $WORKSPACE/obj

mkdir $WORKSPACE/mold
cp $WORKSPACE/obj/x86_64-unknown-linux-gnu/release/mold $WORKSPACE/mold/
# clang's -fuse-ld=mold looks for ld.mold.
ln -s mold $WORKSPACE/mold/ld.mold

$WORKSPACE/mold/mold --version
$CC -B$WORKSPACE/mold -fuse-ld=mold -Wl,--version

tar -C $WORKSPACE -acvf mold.tar.zst mold
mkdir -p $UPLOAD_DIR
mv mold.tar.zst $UPLOAD_DIR
