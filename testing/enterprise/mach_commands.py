# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, # You can obtain one at http://mozilla.org/MPL/2.0/.

import argparse
import importlib.util
import os
import subprocess
import sys

from mach.decorators import Command


def import_from_path(module_name, file_path):
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def get_test_parser():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "what",
        default=None,
        nargs="*",
        help="Tests files to run. If none, will run all.",
    )
    parser.add_argument(
        "--firefox-bin",
        default=None,
        help="Firefox binary to use. Defaults to objdir one.",
    )
    parser.add_argument(
        "--geckodriver-bin",
        default=None,
        help="GeckoDriver binary to use. Defaults to objdir one.",
    )
    parser.add_argument("--debugger", default=None, help="Name of debugger to use.")
    parser.add_argument(
        "--debugger-args",
        default=None,
        help="Command-line arguments to pass to the debugger itself",
    )
    return parser


@Command(
    "enterprise-tests",
    category="testing",
    virtualenv_name="enterprise-tests",
    description="Running enterprise-tests against local build",
    parser=get_test_parser,
)
def run_tests(
    command_context,
    what,
    firefox_bin,
    geckodriver_bin,
    debugger,
    debugger_args,
    **kwargs,
):
    srcdir = os.path.realpath(command_context.topsrcdir)
    objdir = os.path.realpath(command_context.topobjdir)

    extension = ""
    if sys.platform == "win32":
        extension = ".exe"

    enterprise_tests_dir = os.path.join(srcdir, "testing", "enterprise")
    if not firefox_bin:
        firefox_bin = os.path.join(objdir, "dist", "bin", f"firefox{extension}")
        if sys.platform == "darwin":
            import glob

            firefox_bin = glob.glob(
                os.path.join(objdir, "dist", "*.app", "Contents", "MacOS", "firefox")
            )[0]
    assert firefox_bin is not None

    if not geckodriver_bin:
        for build in ["debug", "release"]:
            test_path = os.path.join(
                objdir,
                command_context.substs.get("RUST_TARGET"),
                build,
                f"geckodriver{extension}",
            )
            if os.path.isfile(test_path):
                geckodriver_bin = test_path
                break
    assert geckodriver_bin is not None

    profiles_path = os.path.join(objdir, "tmp", "profiles-tests")
    os.makedirs(profiles_path, exist_ok=True)

    sys.path.append(enterprise_tests_dir)

    testfiles_to_run = (
        what
        if what and len(what) > 0
        else map(
            lambda x: os.path.join(enterprise_tests_dir, x),
            os.listdir(enterprise_tests_dir),
        )
    )
    for test_file in testfiles_to_run:
        filename = os.path.basename(test_file)
        if not filename.startswith("test_"):
            continue

        instance = filename.split("test_")[1].split(".py")[0]
        json_in = os.path.join(enterprise_tests_dir, f"{instance}.json.in")

        if os.path.isfile(json_in):
            os.environ["TOPOBJDIR"] = objdir
            import_from_path("test_firefox_start", test_file)

        final_json = os.path.join(enterprise_tests_dir, f"{instance}.json")
        if os.path.isfile(final_json):
            cli = None
            if debugger:
                cli = (
                    [debugger]
                    + debugger_args.split(" ")
                    + [
                        sys.executable,
                        test_file,
                        firefox_bin,
                        geckodriver_bin,
                        profiles_path,
                    ]
                )
            else:
                cli = [
                    sys.executable,
                    test_file,
                    firefox_bin,
                    geckodriver_bin,
                    profiles_path,
                ]
            print("Running", " ".join(cli))
            try:
                subprocess.check_call(cli)
            except Exception as ex:
                print("Received", ex)
        else:
            print(f"Could not find JSON '{final_json}' for '{test_file}'")

    return 0
