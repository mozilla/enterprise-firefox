# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import logging
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from mach.logging import BUILD_ERROR, SUPPRESSED_WARNING, THIRD_PARTY_WARNING
from mozunit import main

from mozbuild.compilation.warnings import WarningsCollector
from mozbuild.controller.building import BuildOutputManager

STDOUT = "stdout"
STDERR = "stderr"

TOPSRCDIR = Path(__file__).resolve().parents[5].as_posix()

SUPPRESSED_WARNING_FLAGS = [
    "-Wno-error=nonportable-include-path",
]

# fmt: off
# (stream, expected_log_level, line_template)
# Note: {topsrcdir} is replaced with actual TOPSRCDIR at runtime
SAMPLE_LOG_BUILD_OUTPUT_TEMPLATES = [
    (STDOUT, logging.INFO,        "RecursiveMake backend executed in 5.99s"),
    (STDOUT, logging.INFO,        "  5829 total backend files; 5829 created; 0 updated;"),
    (STDOUT, logging.INFO,        "./mozilla-config.h.stub"),
    (STDOUT, logging.INFO,        "./buildid.h.stub"),
    (STDERR, THIRD_PARTY_WARNING, r'D:/.mozbuild/vs/Windows Kits/10/Include/10.0.26100.0/um/objidl.idl(67,10): warning: non-portable path to file "objidlbase.Idl"; specified path differs in case from file name on disk [-Wnonportable-include-path]'),
    (STDERR, THIRD_PARTY_WARNING, '   67 | #include "objidlbase.idl"'),
    (STDERR, THIRD_PARTY_WARNING, "      |          ^~~~~~~~~~~~~~~~"),
    (STDERR, THIRD_PARTY_WARNING, '      |          "objidlbase.Idl"'),
    (STDERR, BUILD_ERROR,         "1 error generated."),
    (STDOUT, logging.INFO,        "./registered_field_trials.h.stub"),
    (STDERR, SUPPRESSED_WARNING,  r'{topsrcdir}/first/party/path/objidl.idl(67,10): warning: non-portable path to file "objidlbase.Idl"; specified path differs in case from file name on disk [-Wnonportable-include-path]'),
    (STDERR, SUPPRESSED_WARNING,  '   67 | #include "objidlbase.idl"'),
    (STDERR, SUPPRESSED_WARNING,  "      |          ^~~~~~~~~~~~~~~~"),
    (STDERR, SUPPRESSED_WARNING,  '      |          "objidlbase.Idl"'),
    (STDERR, BUILD_ERROR,         "1 error generated."),
    (STDOUT, logging.INFO,        "./registered_field_trials.h.stub"),
    (STDERR, THIRD_PARTY_WARNING, "{topsrcdir}/nsprpub/pr/src/misc/prdtoa.c(1261,27): warning: operator '>>' has lower precedence than '-'; '-' will be evaluated first [-Wshift-op-parentheses]"),
    (STDERR, THIRD_PARTY_WARNING, " 1261 |     d1 = z << k | y >> 32 - k;"),
    (STDERR, THIRD_PARTY_WARNING, "      |                     ~~ ~~~^~~"),
    (STDERR, BUILD_ERROR,         "1 error generated."),
    (STDOUT, logging.INFO,        "browser/components/about"),
    (STDOUT, logging.INFO,        "   Compiling syn v2.0.106"),
    (STDERR, logging.WARNING,     "22 warnings generated."),
    (STDOUT, logging.WARNING,     "warning: deprecated API"),
    (STDOUT, logging.INFO,        "   Compiling syn v2.0.106"),
    (STDERR, BUILD_ERROR,         "{topsrcdir}/browser/app/nsBrowserApp.cpp(6,1): error: unknown type name 'syntax'"),
    (STDERR, BUILD_ERROR,         "    6 | syntax error here for testing build output"),
    (STDERR, BUILD_ERROR,         "      | ^"),
    (STDOUT, logging.INFO,        "toolkit/library/build/xul.dll.def.stub"),
    (STDERR, THIRD_PARTY_WARNING, r"lld-link: warning: nss\lib\ssl\ssl_ssl\win32err.obj: locally defined symbol imported: PR_SetError (defined in ..\config\external\nspr\pr\Unified_c_external_nspr_pr2.obj) [LNK4217]"),
    (STDOUT, logging.INFO,        "   Compiling syn v2.0.106"),
    (STDOUT, logging.WARNING,     "warning: windows@0.62.2: ignoring 'hints.mostly-unused', pass `-Zprofile-hint-mostly-unused` to enable it"),
    (STDOUT, logging.WARNING,     "3 warnings:"),
    (STDOUT, logging.WARNING,     '  6010: install function "ExitProcess" not referenced - zeroing code (0-1) out'),
    (STDOUT, logging.WARNING,     '  6010: install function "createProfileCleanup" not referenced - zeroing code (798-855) out'),
    (STDOUT, logging.WARNING,     '  6012: label "OnError" not used'),
    (STDOUT, logging.INFO,        "Packaging mozscreenshots@mozilla.org.xpi..."),
    (STDERR, logging.WARNING,     "592 compiler warnings present."),
    (STDERR, logging.WARNING,     "(suppressed 588 warnings in third-party code)"),
    (STDERR, logging.WARNING,     "(suppressed 2 warnings in ipc/chromium/src/base)"),
    (STDOUT, logging.WARNING,     "warning: error finalizing incremental compilation session directory "),
    (STDERR, logging.WARNING,     '{topsrcdir}/browser/app/nsBrowserApp.cpp(6,2): warning: "test warning for build output" [-W#warnings]'),
    (STDERR, logging.WARNING,     '    6 | #warning "test warning for build output"'),
    (STDERR, logging.WARNING,     "      |  ^"),
    (STDERR, logging.WARNING,     "1 warning generated"),
    (STDOUT, logging.INFO,        "toolkit/components/glean/EventGIFFTMap.cpp.stub"),
    (STDERR, BUILD_ERROR,         "2 error generated."),
    (STDERR, BUILD_ERROR,         "mozmake[4]: *** [{topsrcdir}/config/rules.mk:670: nsBrowserApp.obj] Error 1"),
    (STDERR, BUILD_ERROR,         "mozmake[3]: *** [{topsrcdir}/config/recurse.mk:72: browser/app/target-objects] Error 2"),
    (STDERR, BUILD_ERROR,         "mozmake[3]: *** Waiting for unfinished jobs...."),
    (STDOUT, logging.INFO,        "Finished `release` profile [optimized] target(s) in 6.42s"),
    (STDERR, BUILD_ERROR,         "mozmake[2]: *** [{topsrcdir}/config/recurse.mk:34: compile] Error 2"),
    (STDERR, BUILD_ERROR,         "mozmake[1]: *** [{topsrcdir}/config/rules.mk:359: default] Error 2"),
    (STDERR, BUILD_ERROR,         "mozmake: *** [client.mk:60: build] Error 2"),
    (STDOUT, logging.INFO,        "Finished `release` profile [optimized] target(s) in 6.42s"),
]
# fmt: on


def get_sample_log_build_output():
    return [
        (stream, level, line.format(topsrcdir=TOPSRCDIR))
        for stream, level, line in SAMPLE_LOG_BUILD_OUTPUT_TEMPLATES
    ]


class MockBuildMonitor:
    def __init__(self):
        self.topsrcdir = TOPSRCDIR
        self.substs = {
            "WARNINGS_CFLAGS": SUPPRESSED_WARNING_FLAGS,
            "WARNINGS_CXXFLAGS": SUPPRESSED_WARNING_FLAGS,
        }
        self._warnings_collector = WarningsCollector(cb=lambda w: None)

    def on_line(self, line):
        warning = self._warnings_collector.process_line(line)
        return warning, False, line


class BuildOutputTestHarness:
    def __init__(self):
        self.captured_log_level = None
        self._setup_manager()

    def _setup_manager(self):
        mock_log_manager = MagicMock()
        mock_log_manager.terminal = None
        self.mock_monitor = MockBuildMonitor()

        self.manager = BuildOutputManager(
            mock_log_manager, self.mock_monitor, footer=None
        )

        def capture_log(level, *args, **kwargs):
            self.captured_log_level = level

        self.manager.log = capture_log
        self.manager.log_record = MagicMock()

    def process_line(self, line, stream):
        self.captured_log_level = None
        if stream == STDOUT:
            self.manager.on_stdout_line(line)
        else:
            self.manager.on_stderr_line(line)
        return self.captured_log_level


class TestBuildOutputLogLevel(unittest.TestCase):
    def test_build_output_log_levels(self):
        test_harness = BuildOutputTestHarness()

        for stream, expected, line in get_sample_log_build_output():
            with self.subTest(line=line, stream=stream):
                log_level = test_harness.process_line(line, stream)
                self.assertEqual(
                    log_level,
                    expected,
                    f"Line '{line}' ({stream}) expected {expected}, got {log_level}",
                )


if __name__ == "__main__":
    main()
