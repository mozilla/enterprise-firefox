#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import signal
import subprocess
import sys
import tempfile

sys.path.append(os.path.dirname(__file__))

from base_test import EnterpriseTestsBase

# The Felt UI launch gate (SelectProfile in nsAppRunner.cpp) adopts a scratch
# profile at "${OS_TemporaryDirectory}/felt-${MOZ_UPDATE_CHANNEL}".
# ValidateFeltScratchDir requires a pre-existing directory at that path to be a
# private per-user directory before it is reused: a directory (not a symlink)
# owned by the current user with mode 0700. This test covers the symlink and
# mode cases; the ownership case needs a second local account and is exercised
# separately.
#
# The gate is only reached when no profile is forced on the command line, so this
# test cannot use the Marionette harness (which always passes --profile and skips
# the branch). It launches the built binary directly and reads its output. That
# bare launch performs GTK display setup before profile selection on Linux, so it
# requires a display -- provided by the marionette-enterprise CI environment.
REFUSAL_MESSAGE = "refusing to use the Felt UI scratch profile"


class FeltUIScratchProfileRefuses(EnterpriseTestsBase):
    def _scratch_dir(self):
        # The scratch dir name embeds the build's update channel, so derive it
        # from the running build rather than assuming "default".
        with self.marionette.using_context("chrome"):
            channel = self.marionette.execute_script(
                "return ChromeUtils.importESModule("
                "'resource://gre/modules/AppConstants.sys.mjs'"
                ").AppConstants.MOZ_UPDATE_CHANNEL;"
            )
        base = os.environ.get("TMPDIR", tempfile.gettempdir())
        return os.path.join(base, f"felt-{channel}")

    def _child_env(self):
        # A bare Felt UI launch: inherit the harness environment (notably DISPLAY),
        # but strip anything that would either force a profile -- and thus skip the
        # scratch-profile branch -- or turn the child into an automation instance.
        env = dict(os.environ)
        for key in (
            "MOZ_MARIONETTE",
            "MOZ_BYPASS_FELT",
            "XRE_PROFILE_PATH",
            "XRE_PROFILE_LOCAL_PATH",
        ):
            env.pop(key, None)
        return env

    def _launch_bare_and_capture(self):
        binary = self.marionette.instance.binary
        self._logger.info(f"Launching bare Felt UI binary: {binary}")
        # start_new_session so a hung launch and any child it spawned can be
        # killed as a group rather than left to disturb later tests.
        proc = subprocess.Popen(
            [binary],
            env=self._child_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        try:
            output, _ = proc.communicate(timeout=90)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            proc.communicate()
            raise
        self._logger.info(f"Bare launch exited: {proc.returncode}")
        return proc.returncode, output

    def setUp(self):
        super().setUp()
        # Preserve any real scratch profile so the test never destroys developer
        # state, and start each case from a known-absent path.
        self._scratch_path = self._scratch_dir()
        self._backup_path = f"{self._scratch_path}.test-backup"
        self._decoy_path = None
        if os.path.lexists(self._backup_path):
            self._rmtree_or_unlink(self._backup_path)
        if os.path.lexists(self._scratch_path):
            os.rename(self._scratch_path, self._backup_path)

    def tearDown(self):
        try:
            super().tearDown()
        finally:
            if getattr(self, "_scratch_path", None):
                self._rmtree_or_unlink(self._scratch_path)
            if self._decoy_path and os.path.lexists(self._decoy_path):
                self._rmtree_or_unlink(self._decoy_path)
            if getattr(self, "_backup_path", None) and os.path.lexists(
                self._backup_path
            ):
                os.rename(self._backup_path, self._scratch_path)

    def _rmtree_or_unlink(self, path):
        import shutil

        if os.path.islink(path) or os.path.isfile(path):
            os.unlink(path)
        else:
            shutil.rmtree(path, ignore_errors=True)

    def _snapshot(self, path):
        # (mtime, size) of |path| and every entry under it, so an added,
        # removed, or modified entry is all detected -- a bare directory mtime
        # would miss writes into a pre-existing file.
        snap = {".": (os.stat(path).st_mtime_ns,)}
        for root, dirs, files in os.walk(path):
            for name in dirs + files:
                p = os.path.join(root, name)
                st = os.lstat(p)
                snap[os.path.relpath(p, path)] = (st.st_mtime_ns, st.st_size)
        return snap

    def test_refuses_directory_symlink(self):
        # A symlink at the scratch path must be rejected (lstat/!S_ISDIR) rather
        # than followed, so neither adoption nor the wipe traverses it.
        self._decoy_path = tempfile.mkdtemp(prefix="felt-refuse-decoy")
        open(os.path.join(self._decoy_path, "canary"), "w").close()
        before = self._snapshot(self._decoy_path)

        os.symlink(self._decoy_path, self._scratch_path)

        returncode, output = self._launch_bare_and_capture()
        assert REFUSAL_MESSAGE in output, (
            f"Expected refusal for a symlinked scratch profile; output was:\n{output}"
        )
        assert returncode == 1, f"Expected exit code 1, got {returncode}"
        # The launch must refuse before following the symlink into the target.
        assert self._snapshot(self._decoy_path) == before, (
            "The symlink target was modified; the launch should have refused "
            "before touching it"
        )

    def test_refuses_group_or_world_accessible_directory(self):
        # A scratch directory that is group- or world-accessible must be
        # rejected; only mode 0700 is accepted.
        os.makedirs(self._scratch_path, mode=0o700, exist_ok=True)
        open(os.path.join(self._scratch_path, "canary"), "w").close()
        os.chmod(self._scratch_path, 0o777)
        before = self._snapshot(self._scratch_path)

        returncode, output = self._launch_bare_and_capture()
        assert REFUSAL_MESSAGE in output, (
            f"Expected refusal for a 0777 scratch profile; output was:\n{output}"
        )
        assert returncode == 1, f"Expected exit code 1, got {returncode}"
        # The launch must refuse before populating the directory as a profile.
        assert self._snapshot(self._scratch_path) == before, (
            "The scratch directory was written to; the launch should have "
            "refused before using it"
        )
