#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import shutil
import struct
import sys
import tempfile
import unittest

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests

# The Felt UI launch gate (toolkit/xre/nsAppRunner.cpp) selects a scratch
# profile directory at "${OS_TemporaryDirectory}/felt-{MOZ_UPDATE_CHANNEL}".
# For local/dev builds MOZ_UPDATE_CHANNEL is "default". If that directory is
# found to contain plaintext canonical SQLite databases at startup (while the
# build requires encrypted profile storage), the gate silently wipes the
# directory and proceeds rather than prompting the user -- the scratch
# profile is by design disposable. This test exercises that silent-recovery
# path end-to-end: plant a plaintext-looking SQLite file in the scratch dir,
# launch Felt, and confirm the file was removed without any error UI.
FELT_SCRATCH_DIR_NAME = "felt-default"


@unittest.skip(
    "TODO(Bug 1996558): rework before re-enabling. The Marionette harness "
    "starts Felt with --profile <marionette-tmpdir>, which sets forcedProfile "
    "in SelectStartupProfile (nsAppRunner.cpp ~3296) and SKIPS the "
    "${TMPDIR}/felt-${MOZ_UPDATE_CHANNEL} scratch-profile branch the test "
    "needs to exercise. The planted plaintext file therefore lives in a "
    "directory the launched Firefox never inspects, and "
    "ResetFeltUIScratchProfile is never reached. Two viable rewrites: "
    "(a) drive Firefox without Marionette (so no --profile is passed) and "
    "scrape stdout/stderr for the silent-wipe log line, or "
    "(b) plant the plaintext file inside the Marionette-supplied profile dir "
    "and assert the gate's eager-mark path wipes it (different code path "
    "than ResetFeltUIScratchProfile). The current test is preserved as a "
    "structural starting point for whichever direction reviewers prefer."
)
class FeltUIScratchReset(FeltTests):
    def _scratch_dir(self):
        # Match what OS_TemporaryDirectory resolves to on macOS/Linux: prefer
        # $TMPDIR (always set on macOS to the per-user /var/folders/... path),
        # falling back to tempfile.gettempdir() (which is /tmp on Linux when
        # $TMPDIR is unset). Anything more clever would risk diverging from
        # what the running Firefox sees.
        base = os.environ.get("TMPDIR", tempfile.gettempdir())
        return os.path.join(base, FELT_SCRATCH_DIR_NAME)

    def _plant_plaintext_places_sqlite(self, scratch_dir):
        # DetectEncryptedDBHeader reads the first 24 bytes of a canonical DB
        # and classifies by:
        #   - page_size: big-endian u16 at offset 16
        #   - reserved : u8 at offset 20
        # An obfsvfs-encrypted DB has page_size=8192, reserved=32. Anything
        # else with a valid SQLite magic counts as Plaintext, which is what
        # we want to provoke here. Write a real-ish SQLite header with the
        # standard plaintext defaults: page_size=4096, reserved=0.
        os.makedirs(scratch_dir, mode=0o700, exist_ok=True)
        header = bytearray(24)
        # Bytes 0..15: SQLite magic string, NUL-terminated.
        magic = b"SQLite format 3\x00"
        header[0 : len(magic)] = magic
        # Bytes 16..17: page_size big-endian u16. 4096 = plaintext default.
        struct.pack_into(">H", header, 16, 4096)
        # Bytes 18..23 stay zero; in particular reserved (offset 20) = 0
        # which definitively does not match obfsvfs's 32.
        path = os.path.join(scratch_dir, "places.sqlite")
        with open(path, "wb") as f:
            f.write(bytes(header))
        return path

    def setUp(self):
        # Plant the plaintext DB BEFORE super().setUp() launches Firefox: the
        # encryption gate runs during early startup, so the file must already
        # exist when Felt's binary comes up. Record both paths so teardown can
        # clean up even if the test bails partway through.
        self._scratch_path = self._scratch_dir()
        self._planted_sqlite = self._plant_plaintext_places_sqlite(self._scratch_path)
        assert os.path.isfile(self._planted_sqlite), (
            f"plaintext places.sqlite was not planted at {self._planted_sqlite}"
        )
        super().setUp()

    def tearDown(self):
        try:
            super().tearDown()
        finally:
            # Always remove the scratch directory we created, regardless of
            # whether the gate already wiped its contents. ignore_errors so a
            # transient lock (e.g. on macOS by Spotlight) does not mask a real
            # test failure raised by tearDown above.
            shutil.rmtree(self._scratch_path, ignore_errors=True)

    def test_felt_ui_silently_resets_plaintext_scratch_profile(self):
        # If we got here, FeltTests.setUp() / setup() already launched Felt
        # and saw exactly one chrome window (it asserts that itself). That
        # alone proves the gate did NOT raise a dialog: a dialog would have
        # produced a second window (or replaced the Felt window with an
        # error one) and the harness would have failed earlier. Re-assert
        # explicitly here so a future change to setup() does not silently
        # weaken this test.
        self._driver.set_context("chrome")
        handles = self._driver.chrome_window_handles
        assert len(handles) == 1, (
            f"Expected exactly one Felt chrome window after silent scratch "
            f"reset, got {len(handles)}: {handles}"
        )

        # The silent-wipe path (ResetFeltUIScratchProfile in nsAppRunner.cpp)
        # removes every entry of the scratch profile directory and recreates
        # the directory empty. So: our planted places.sqlite must be gone,
        # but the scratch directory itself must still exist (recreated).
        assert not os.path.exists(self._planted_sqlite), (
            f"Planted plaintext places.sqlite should have been wiped by the "
            f"Felt UI launch gate, but it still exists at "
            f"{self._planted_sqlite}"
        )
        assert os.path.isdir(self._scratch_path), (
            f"Felt UI scratch directory should have been recreated empty by "
            f"the launch gate, but is missing at {self._scratch_path}"
        )
