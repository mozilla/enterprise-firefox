# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import hashlib
import os
import shutil
import subprocess
import tempfile

import buildconfig
from mozbuild.nodeutil import find_node_executable, package_setup
from mozbuild.util import FileAvoidWrite


def _newtab_dir():
    return os.path.join(buildconfig.topsrcdir, "browser", "extensions", "newtab")


def _node():
    node, _ = find_node_executable(nodejs_exe=buildconfig.substs.get("NODEJS"))
    if not node:
        raise Exception(
            "Node.js is required to build newtab bundles. "
            "Ensure node is in PATH or set NODEJS in your environment."
        )
    return node


def _hash_sources(newtab_dir):
    hasher = hashlib.sha256()
    watch_dirs = [
        os.path.join(newtab_dir, "content-src"),
        os.path.join(newtab_dir, "common"),
    ]
    watch_files = [
        os.path.join(newtab_dir, "package.json"),
        os.path.join(newtab_dir, "package-lock.json"),
        os.path.join(newtab_dir, "webpack.system-addon.config.js"),
    ]
    for path in watch_files:
        if os.path.exists(path):
            with open(path, "rb") as f:
                hasher.update(f.read())
    for watch_dir in watch_dirs:
        for root, dirs, files in os.walk(watch_dir):
            dirs.sort()
            for fname in sorted(files):
                if fname.endswith((".jsx", ".js", ".mjs", ".scss")):
                    with open(os.path.join(root, fname), "rb") as f:
                        hasher.update(f.read())
    return hasher.digest()


def _lockfile_hash(newtab_dir):
    lock_path = os.path.join(newtab_dir, "package-lock.json")
    if not os.path.exists(lock_path):
        return b""
    hasher = hashlib.sha256()
    with open(lock_path, "rb") as f:
        hasher.update(f.read())
    return hasher.digest()


def _fetched_node_modules():
    """In CI the deps are provided by the newtab-node-modules toolchain task and
    unpacked to $MOZ_FETCHES_DIR/newtab/node_modules, so the build stays hermetic
    (no network access at build time). Returns that path if present."""
    fetches_dir = os.environ.get("MOZ_FETCHES_DIR")
    if not fetches_dir:
        return None
    fetched = os.path.join(fetches_dir, "newtab", "node_modules")
    return fetched if os.path.isdir(fetched) else None


def ensure_node_modules(output):
    """Stamp target; runs before generate_js/generate_css so the install
    completes once before they run in parallel.

    Writes a hash of all source files so downstream GeneratedFile targets
    only rebuild when sources actually change."""
    newtab_dir = _newtab_dir()
    webpack = os.path.join(newtab_dir, "node_modules", "webpack", "bin", "webpack.js")

    # Reinstall when node_modules is missing/incomplete or when package-lock.json
    # has changed since the last install, so dependency bumps take effect without
    # a manual `./mach newtab install`.
    install_stamp = os.path.join(newtab_dir, "node_modules", ".newtab-install-stamp")
    lock_hash = _lockfile_hash(newtab_dir)
    installed_hash = b""
    if os.path.exists(install_stamp):
        with open(install_stamp, "rb") as f:
            installed_hash = f.read()

    if not os.path.exists(webpack) or installed_hash != lock_hash:
        # Prefer node_modules staged by the newtab-node-modules toolchain in CI,
        # which avoids a network `npm ci` during the build.
        fetched = _fetched_node_modules()
        if fetched:
            dest = os.path.join(newtab_dir, "node_modules")
            if os.path.exists(dest):
                shutil.rmtree(dest)
            # Skip .bin: its POSIX symlinks (archive built on Linux) break
            # copytree on Windows, and the build never invokes tools via .bin.
            shutil.copytree(fetched, dest, ignore=shutil.ignore_patterns(".bin"))
            with open(install_stamp, "wb") as f:
                f.write(lock_hash)
            output.write(_hash_sources(newtab_dir))
            return

        if os.environ.get("MOZ_FETCHES_DIR"):
            raise Exception(
                "newtab-node-modules must be fetched in CI: add it to this "
                "task's toolchain fetches."
            )

        # Local dev builds: install via mozbuild's shared helper, which locates
        # node/npm and runs `npm ci` (handles the node-on-PATH and Windows npm
        # launcher details for us).
        if package_setup(newtab_dir, "newtab"):
            raise Exception(
                "Failed to install newtab node dependencies. "
                "Run ./mach newtab install manually."
            )

        with open(install_stamp, "wb") as f:
            f.write(lock_hash)

    output.write(_hash_sources(newtab_dir))


def generate_js(output, node_modules_stamp):
    newtab_dir = _newtab_dir()
    node = _node()
    webpack = os.path.join(newtab_dir, "node_modules", "webpack", "bin", "webpack.js")

    if not os.path.exists(webpack):
        raise Exception(
            "webpack not found. Run ./mach newtab install to install dependencies."
        )

    content_dir = os.path.dirname(output.name)
    as_path = os.path.join(content_dir, "activity-stream.bundle.js")

    with tempfile.TemporaryDirectory() as tmpdir:
        result = subprocess.run(
            [
                node,
                webpack,
                "--config",
                os.path.join(newtab_dir, "webpack.system-addon.config.js"),
                "--env",
                "outputPath=" + tmpdir,
            ],
            check=False,
            cwd=newtab_dir,
        )
        if result.returncode != 0:
            raise Exception(f"webpack failed with exit code {result.returncode}")

        with open(os.path.join(tmpdir, "vendor.bundle.js"), "rb") as f:
            output.write(f.read())

        with FileAvoidWrite(as_path, readmode="rb") as as_output:
            with open(os.path.join(tmpdir, "activity-stream.bundle.js"), "rb") as f:
                as_output.write(f.read())


def generate_css(output, node_modules_stamp):
    newtab_dir = _newtab_dir()
    node = _node()
    sass = os.path.join(newtab_dir, "node_modules", "sass", "sass.js")

    if not os.path.exists(sass):
        raise Exception(
            "sass not found. Run ./mach newtab install to install dependencies."
        )

    css_dir = os.path.dirname(output.name)
    nova_css_path = os.path.join(css_dir, "nova", "activity-stream.css")

    src_styles_dir = os.path.join(newtab_dir, "content-src", "styles")

    with tempfile.TemporaryDirectory() as tmpdir:
        result = subprocess.run(
            [
                node,
                sass,
                src_styles_dir + ":" + tmpdir,
                "--no-source-map",
            ],
            check=False,
            cwd=newtab_dir,
        )
        if result.returncode != 0:
            raise Exception(f"sass failed with exit code {result.returncode}")

        with open(os.path.join(tmpdir, "activity-stream.css"), "rb") as f:
            output.write(f.read())

        os.makedirs(os.path.dirname(nova_css_path), exist_ok=True)
        with FileAvoidWrite(nova_css_path, readmode="rb") as nova_output:
            with open(os.path.join(tmpdir, "nova", "activity-stream.css"), "rb") as f:
                nova_output.write(f.read())
