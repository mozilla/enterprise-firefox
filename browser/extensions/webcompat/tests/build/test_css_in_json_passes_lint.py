import json
import os
import subprocess
from tempfile import TemporaryDirectory

import buildconfig
import mozpack.path as mozpath
from mozpack.files import FileFinder


def json_interventions(interventions_dir, harness):
    input_files = list(FileFinder(interventions_dir).find("*.json"))
    for json_filename, json_fd in input_files:
        try:
            yield json_filename, json.load(json_fd)
        except json.decoder.JSONDecodeError as e:
            harness.ok(False, f"{json_filename} is invalid JSON: {e}")


def WebCompatBuildTest(harness):
    mach_path = mozpath.join(buildconfig.topsrcdir, "mach")
    if not os.path.isfile(mach_path) or not os.access(mach_path, os.X_OK):
        raise ValueError("Could not find mach to run linter")
    interventions_reldir = mozpath.join(
        "browser", "extensions", "webcompat", "data", "interventions"
    )
    interventions_dir = mozpath.join(buildconfig.topsrcdir, interventions_reldir)

    # It can take a long time to run mach lint on each CSS fragment, so we generate
    # a temporary directory filled with files for it to bulk-test, then parse the
    # results of that command.
    with TemporaryDirectory(
        dir=interventions_dir, ignore_cleanup_errors=True
    ) as to_lint_dir:
        for json_filename, config in json_interventions(interventions_dir, harness):
            for cssName, cssText in config.get("css", {}).items():
                css_filename = f"{json_filename}-{cssName}.css"
                css_filepath = mozpath.join(to_lint_dir, css_filename)
                with open(css_filepath, "w") as css_file:
                    css_file.write(cssText)

        linting_result = subprocess.run(
            [mach_path, "lint", to_lint_dir],
            stdout=subprocess.PIPE,
            check=False,
            text=True,
        ).stdout

        # The output should look like this. We only care about the lines with [error]:
        # 0:06.85   0   error  An error occurred running prettier. Please check the following error messages:
        # 0:06.85
        # 0:06.85 [error] browser/extensions/webcompat/data/interventions/tmp6q8stvbu/1899930-africanews.com.json-hide_browser_notice.css: SyntaxError: CssSyntaxError: Unexpected } (1:56)
        # 0:06.85 [error] > 1 | #platform-detection-info { display: none !important; } }
        # 0:06.85 [error]     |                                                        ^  prettier (stylelint)
        # 0:06.85
        # 0:06.85 /full/path/to/build/browser/extensions/webcompat/data/interventions/tmp6q8stvbu/1575000-apply.lloydsbank.co.uk.json-fix_misaligned_radio_buttons.css
        # 0:06.85   0   error  No matching license strings found in tools/lint/license/valid-licenses.txt  (license)
        # 0:06.85   0   error  This file needs formatting with Prettier (use 'mach lint --fix <path>').    prettier (stylelint)
        # 0:06.85   1   error  File does not end with newline character                                    (file-whitespace)

        def parse_fragment_errors(linter_stdout):
            error_lines_for_current_css_fragment = None
            for line in linter_stdout.splitlines():
                if "[error]" not in line:
                    continue

                # we hit the next css fragment being linted when we reach a line like this:
                # 0:06.85 [error] browser/extensions/webcompat/data/interventions/tmp6q8stvbu/1899930-africanews.com.json-hide_browser_notice.css: SyntaxError: CssSyntaxError: Unexpected } (1:56)
                if interventions_reldir in line:
                    if error_lines_for_current_css_fragment:
                        yield error_lines_for_current_css_fragment

                    [linted_filename, error] = line.split("[error]", maxsplit=1)[
                        1
                    ].split(":", maxsplit=1)
                    linted_filename = mozpath.splitext(
                        mozpath.basename(linted_filename)
                    )[0]
                    [src_json_file, css_fragment_name] = linted_filename.split(
                        ".json-", maxsplit=1
                    )
                    summary_line = f"Error in CSS fragment named {css_fragment_name} in {src_json_file}.json: {error}"
                    error_lines_for_current_css_fragment = [summary_line]
                else:
                    error_lines_for_current_css_fragment.append(
                        line.split("[error] ", maxsplit=1)[1]
                    )

            if error_lines_for_current_css_fragment:
                yield "\n".join(error_lines_for_current_css_fragment)

        bad_fragments = list(parse_fragment_errors(linting_result))
        if not bad_fragments:
            harness.ok(True, "mach lint found no errors with CSS fragments")
        else:
            for fragment_error in bad_fragments:
                harness.ok(False, fragment_error)
