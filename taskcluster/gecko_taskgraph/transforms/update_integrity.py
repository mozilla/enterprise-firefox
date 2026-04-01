# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import shlex

from taskgraph.transforms.base import TransformSequence
from taskgraph.util.schema import resolve_keyed_by

transforms = TransformSequence()


@transforms.add
def skip_for_non_nightly(config, jobs):
    """Don't generate any jobs unless running as a nightly. Other code in this transform depends on nightly-specific parameters being set."""
    if not config.params["release_history"]:
        return

    yield from jobs


@transforms.add
def resolve_keys(config, jobs):
    for job in jobs:
        for key in ("cert-overrides", "fetches.toolchain"):
            resolve_keyed_by(
                job,
                key,
                job["name"],
                **{
                    "build-platform": job["attributes"]["build_platform"],
                    "project": config.params["project"],
                },
            )

        yield job


@transforms.add
def set_treeherder(config, jobs):
    for job in jobs:
        th = job.setdefault("treeherder", {})
        attrs = job["attributes"]
        attrs["locale"] = attrs.get("locale", "en-US")

        th["platform"] = f"{attrs['build_platform']}/{attrs['build_type']}"
        th["symbol"] = th["symbol"].format(**attrs)
        yield job


@transforms.add
def add_to_installer(config, jobs):
    """Adds fetch entries for the "to" installer to fetches."""
    for job in jobs:
        if "linux" in job["attributes"]["build_platform"]:
            job["fetches"]["build-signing"] = [
                {"artifact": "target.tar.xz", "extract": False}
            ]
        elif "mac" in job["attributes"]["build_platform"]:
            job["fetches"]["repackage"] = [{"artifact": "target.dmg"}]
        elif "win" in job["attributes"]["build_platform"]:
            job["fetches"]["repackage"] = [{"artifact": "target.installer.exe"}]
        else:
            raise Exception(
                "unsupported platform: {job['attributes']['build_platform']}!"
            )

        yield job


@transforms.add
def add_additional_fetches_and_command(config, jobs):
    """Adds fetch entries for the "from" installers and partial MARs."""
    for job in jobs:
        # checked before `linux64` to avoid `linux64-aarch64` ending up with
        # `linux64` information
        if job["attributes"]["build_platform"].startswith("linux64-aarch64"):
            platform = "linux"
            build_target = "Linux_aarch64-gcc3"
            installer_suffix = "tar.xz"
        elif job["attributes"]["build_platform"].startswith("linux64"):
            platform = "linux"
            build_target = "Linux_x86_64-gcc3"
            installer_suffix = "tar.xz"
        elif job["attributes"]["build_platform"].startswith("mac"):
            platform = "mac"
            build_target = "Darwin_x86_64-gcc3-u-i386-x86_64"
            installer_suffix = "dmg"
        elif job["attributes"]["build_platform"].startswith("win32"):
            platform = "win"
            build_target = "WINNT_x86-msvc"
            installer_suffix = "installer.exe"
        # checked before `win64` to avoid `win64-aarch64` ending up with
        # `win64` information
        elif job["attributes"]["build_platform"].startswith("win64-aarch64"):
            platform = "win"
            build_target = "WINNT_aarch64-msvc-aarch64"
            installer_suffix = "installer.exe"
        elif job["attributes"]["build_platform"].startswith("win64"):
            platform = "win"
            build_target = "WINNT_x86_64-msvc"
            installer_suffix = "installer.exe"
        else:
            raise Exception("couldn't detect build target")

        # ideally, this attribute would be set on en-US jobs as well...but it's not, so we have to assume
        locale = job["attributes"].get("locale", "en-US")

        cmd = [
            # add dmg tool location to the $PATH. this is not strictly necessary
            # for non-mac tests, but it's harmless
            "export PATH=$MOZ_FETCHES_DIR/dmg:$PATH &&",
            # test runner
            "/builds/worker/fetches/marannon/marannon",
            # script that actually runs the tests - eventually to be replaced
            # with native code
            "tools/update-verify/release/common/check_updates.sh",
            # platform - used to determine how to unpack builds
            platform,
            # "to" installer
            f"/builds/worker/fetches/target.{installer_suffix}",
            # "to" complete mar
            "/builds/worker/fetches/target.complete.mar",
            # directory containing partial mars
            "/builds/worker/fetches",
            # locale
            locale,
            # channel - stop hardcoding
            "nightly-try",
            # app name - stop hardcoding
            "firefox",
            # artifact dir
            "/builds/worker/artifacts",
        ]

        cert_overrides = job.pop("cert-overrides")
        if cert_overrides:
            cmd.extend([
                # script that does certificate replacements in the updater
                "--cert-replace-script",
                "tools/update-verify/release/replace-updater-certs.py",
                # directory containing mar certificates
                # note we use versions from tools/update-verify, not the ones
                # in toolkit/mozapps/update/updater, which are not precisely
                # the same size, and injecting them would corrupt the binary
                "--cert-dir",
                "tools/update-verify/release/mar_certs",
            ])
            for override in cert_overrides:
                cmd.extend(["--cert-override", shlex.quote(override)])

        fetches = []
        for mar, info in config.params["release_history"][build_target][locale].items():
            fetches.append({"artifact": mar})
            # parameters give us the complete MAR url. installers are found right
            # beside them
            base_url = info["mar_url"].split(".complete.mar")[0]
            buildid = info["buildid"]

            # regardless of what platform is under test, we perform the tests
            # with the 64-bit linux updater
            linux64_info = config.params["release_history"]["Linux_x86_64-gcc3"][
                locale
            ][mar]
            linux64_installer = linux64_info["mar_url"].replace(
                ".complete.mar", ".tar.xz"
            )
            # installers and updaters are fetched from URLs (not upstream tasks); we simply
            # inject these into the task for the payload to deal with
            cmd.append("--from")
            cmd.append(
                shlex.quote(
                    f"{buildid}|{base_url}.{installer_suffix}|{linux64_installer}|{mar}"
                )
            )

        job["fetches"]["partials-signing"] = fetches
        job["run"]["command"] = " ".join(cmd)

        yield job
