#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import configparser
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.append(os.path.dirname(__file__))

from marionette_harness import MarionetteTestCase

# 24 bytes that mimic the start of an unencrypted SQLite v3 file: the
# "SQLite format 3\0" magic, a 4096-byte page-size, and reserved=0 so the
# launch-gate sniffs RefuseMigrationRequired.
PLAINTEXT_SQLITE_HEADER = (
    b"SQLite format 3\x00"
    b"\x10\x00"  # page size = 4096 (big-endian)
    b"\x01\x01"  # write/read versions
    b"\x00"  # reserved space at page end = 0 (plaintext)
    b"\x40\x20\x20"
)
assert len(PLAINTEXT_SQLITE_HEADER) == 24


@unittest.skip(
    "TODO(Bug 1996558): rework before re-enabling. For the delete/keep "
    "branches, HandleBrowsingChildEncryptionMismatch ends in "
    "LaunchChild(false, /*aTryExec*/true) -- on Linux/macOS that's an execv "
    "(nsAppRunner.cpp ~2735-2740), so the subprocess.run() in this test "
    "keeps blocking on the SAME PID until the 180s timeout, because the "
    "relaunched headless Firefox has no Marionette socket and nothing tells "
    "it to exit. The 'quit' branch returns NS_OK and exits cleanly, so only "
    "that case is observable today. Possible rewrites: drop --tryExec for "
    "the relaunch (so subprocess.run sees the parent exit immediately and "
    "the child becomes a detached process to be terminated by the test), "
    "OR add an instrumentation hook (write a marker file at the new profile "
    "before LaunchChild) that the test can poll for. The current test is "
    "preserved as a structural starting point."
)
class BrowsingChildEncryptionMismatch(MarionetteTestCase):
    """Drive HandleBrowsingChildEncryptionMismatch via the
    MOZ_TEST_AUTO_CONFIRM_PROFILE_RESET test override, parameterized over
    delete/keep/quit."""

    def setUp(self):
        super().setUp()
        self._binary = self.marionette.instance.binary
        self.marionette.instance.close(clean=True)
        self._workdir = tempfile.mkdtemp(prefix="encmismatch-")
        self._logger = self.logger

    def tearDown(self):
        shutil.rmtree(self._workdir, ignore_errors=True)
        super().tearDown()

    def _env(self, extra=None):
        env = os.environ.copy()
        env.update({
            "MOZ_HEADLESS": "1",
            "HOME": self._workdir,
            "XDG_CONFIG_HOME": os.path.join(self._workdir, ".config"),
            "XDG_DATA_HOME": os.path.join(self._workdir, ".local", "share"),
        })
        if extra:
            env.update(extra)
        return env

    def _run(self, args, extra_env=None, timeout=180):
        self._logger.info(f"Launching: {self._binary} {args}")
        return subprocess.run(
            [self._binary] + args,
            env=self._env(extra_env),
            timeout=timeout,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )

    def _create_profile(self, profiles_dir, name):
        path = os.path.join(profiles_dir, name)
        os.makedirs(path, exist_ok=True)
        result = self._run(
            ["--CreateProfile", f"{name} {path}", "-no-remote"],
            extra_env={"MOZ_LEGACY_PROFILES": "1"},
            timeout=60,
        )
        assert result.returncode == 0, (
            f"--CreateProfile failed rc={result.returncode}\n"
            f"{result.stdout.decode('utf-8', errors='replace')}"
        )
        return path

    def _plant_plaintext_db(self, profile_path):
        with open(os.path.join(profile_path, "cookies.sqlite"), "wb") as f:
            f.write(PLAINTEXT_SQLITE_HEADER)
            f.write(b"\x00" * (4096 - len(PLAINTEXT_SQLITE_HEADER)))

    def _find_profiles_ini(self):
        candidates = [
            # The HOME we set above also drives XDG_CONFIG_HOME, so profiles.ini
            # lives under $XDG_CONFIG_HOME/mozilla/firefox/ -- not under
            # ~/.mozilla/firefox/ which is the legacy non-XDG path.
            os.path.join(
                self._workdir, ".config", "mozilla", "firefox", "profiles.ini"
            ),
        ]
        if sys.platform == "darwin":
            candidates.insert(
                0,
                os.path.join(
                    self._workdir,
                    "Library",
                    "Application Support",
                    "Firefox",
                    "profiles.ini",
                ),
            )
        for c in candidates:
            if os.path.isfile(c):
                return c
        raise AssertionError(f"profiles.ini not found; searched {candidates}")

    def _read_profiles_ini(self):
        cp = configparser.ConfigParser()
        cp.read(self._find_profiles_ini())
        return cp

    def _default_path(self, cp):
        for s in cp.sections():
            if s.startswith("Install"):
                return cp[s].get("Default")
        for s in cp.sections():
            if s.startswith("Profile") and cp[s].get("Default") == "1":
                return cp[s].get("Path")
        return None

    def _profile_paths(self, cp):
        return [
            cp[s].get("Path")
            for s in cp.sections()
            if s.startswith("Profile") and cp[s].get("Path")
        ]

    def _exercise(self, choice):
        profiles_dir = os.path.join(self._workdir, "profiles")
        os.makedirs(profiles_dir, exist_ok=True)
        # FeltProcessParent.sys.mjs derives this name; the gate uses
        # is_felt_browser() which keys on the enterprise-profile-* prefix.
        name = "enterprise-profile-default-abcdef0123"
        old_path = self._create_profile(profiles_dir, name)
        self._plant_plaintext_db(old_path)
        siblings_before = set(os.listdir(profiles_dir))

        result = self._run(
            ["-felt", "--profile", old_path, "-no-remote", "-headless"],
            extra_env={"MOZ_TEST_AUTO_CONFIRM_PROFILE_RESET": choice},
            timeout=180,
        )
        out = result.stdout.decode("utf-8", errors="replace")
        self._logger.info(
            f"choice={choice} rc={result.returncode}; tail:\n{out[-1500:]}"
        )
        return profiles_dir, old_path, siblings_before

    def _assert_delete(self, profiles_dir, old_path, before):
        assert not os.path.exists(old_path), (
            f"delete: old profile dir {old_path} should be gone"
        )
        new_dirs = set(os.listdir(profiles_dir)) - before
        assert len(new_dirs) == 1, f"delete: expected one new dir, saw {new_dirs}"
        cp = self._read_profiles_ini()
        default = self._default_path(cp)
        assert default and default.endswith(new_dirs.pop()), (
            f"delete: profiles.ini Default ({default}) should point at the new dir"
        )

    def _assert_keep(self, profiles_dir, old_path, before):
        assert os.path.exists(old_path), (
            f"keep: old profile dir {old_path} should still exist"
        )
        assert os.path.exists(os.path.join(old_path, "cookies.sqlite")), (
            "keep: plaintext cookies.sqlite should still be on disk"
        )
        new_dirs = set(os.listdir(profiles_dir)) - before
        assert len(new_dirs) == 1, f"keep: expected one new dir, saw {new_dirs}"
        cp = self._read_profiles_ini()
        old_base = os.path.basename(old_path)
        assert any(p.endswith(old_base) for p in self._profile_paths(cp)), (
            f"keep: old profile path should still be registered; paths={self._profile_paths(cp)}"
        )
        default = self._default_path(cp)
        new_dir = next(iter(new_dirs))
        assert default and default.endswith(new_dir), (
            f"keep: profiles.ini Default ({default}) should point at new dir ({new_dir})"
        )

    def _assert_quit(self, profiles_dir, old_path, before):
        assert os.path.exists(old_path), (
            f"quit: old profile dir {old_path} should still exist"
        )
        assert os.path.exists(os.path.join(old_path, "cookies.sqlite")), (
            "quit: plaintext cookies.sqlite should still be on disk"
        )
        after = set(os.listdir(profiles_dir))
        assert after == before, f"quit: no new dir should appear; new={after - before}"
        cp = self._read_profiles_ini()
        default = self._default_path(cp)
        if default:
            assert default.endswith(os.path.basename(old_path)), (
                f"quit: profiles.ini Default ({default}) should still point at old dir"
            )

    def test_browsing_child_encryption_mismatch(self):
        asserters = {
            "delete": self._assert_delete,
            "keep": self._assert_keep,
            "quit": self._assert_quit,
        }
        for choice in ("delete", "keep", "quit"):
            with self.subTest(choice=choice):
                # Fresh workdir per iteration: profiles.ini from a prior
                # iteration would otherwise contaminate the next.
                shutil.rmtree(self._workdir, ignore_errors=True)
                os.makedirs(self._workdir, exist_ok=True)
                asserters[choice](*self._exercise(choice))
