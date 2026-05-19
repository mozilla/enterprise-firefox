# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import json
import os
import re
import shutil
import unicodedata

import mozpack.path as mozpath
from mozpack.files import FileFinder


def clear_dir(path):
    if not os.path.isdir(path) and not os.path.islink(path):
        raise Exception(f"{path} is not a directory")
    for filename in os.listdir(path):
        file_path = mozpath.join(path, filename)
        try:
            if os.path.isfile(file_path) or os.path.islink(file_path):
                os.unlink(file_path)
            elif os.path.isdir(file_path):
                shutil.rmtree(file_path)
        except Exception as e:
            print(f"Failed to delete {file_path}. Reason: {e}")


def safe_filename(raw):
    subbed = re.sub(
        "_+",
        "_",
        raw
        .replace(" ", "_")
        .replace("\\", "_")
        .replace("/", "_")
        .replace(os.path.sep, "_")
        .replace("(", "")
        .replace(")", ""),
    )
    normalized = unicodedata.normalize("NFD", subbed)
    return "".join([c for c in normalized if not unicodedata.combining(c)])


def determine_generated_content_scripts_for_intervention(
    config, bug_number, src_json_filename
):
    # The JSON files for interventions may contain css sections like this:
    #
    #  "label": "whatever.com",
    #  "css": {
    #      "fix_broken_slider": "css text 1",
    #      "remove_extra_scrollbars": "css text 2"
    #  },
    #  "interventions": [
    #    {
    #      "css": ["fix_broken_slider"]
    #    },
    #    {
    #      "css": {
    #        "all_frames": true,
    #        "match_origin_as_fallback": true,
    #        "which": ["fix_broken_slider", "remove_extra_scrollbars"]
    #      }
    #    }
    #  ]
    #
    # These must be replaced with corresponding content_scripts sections while building the
    # final run.js (and the files it references must also be generated):
    #
    #  "label": "whatever.com",
    #  "interventions": [
    #    {
    #      "content_scripts": {
    #        "css": ["injections/generated/bug12345_whatever.com_fix_broken_slider.css"]
    #      }
    #    },
    #    {
    #      "content_scripts": {
    #        "all_frames": true,
    #        "match_origin_as_fallback": true,
    #        "css": ["injections/generated/bug12345_whatever.com_fix_broken_slider.css",
    #                "injections/generated/bug12345_whatever.com_remove_extra_scrollbars.css"]
    #      }
    #    }
    #  ]

    VALID_META_KEYS = ["all_frames", "match_origin_as_fallback"]

    files_to_generate = {}

    if "css" in config and (type(config["css"]) is not dict or not config["css"]):
        raise ValueError(
            f"css section should be a non-empty object or be removed from {src_json_filename}"
        )

    css_files = config.pop("css", None)
    if not css_files:
        for intervention in config["interventions"]:
            if intervention.get("css"):
                raise ValueError(
                    f"css wanted, but none specified for {src_json_filename}"
                )
        return files_to_generate

    actually_used_files = set()

    for cssText in css_files.values():
        if type(cssText) is not str or not cssText:
            raise ValueError(
                f"css text should be a non-empty string in {src_json_filename}"
            )

    label = safe_filename(config["label"])
    for intervention in config["interventions"]:
        css = intervention.pop("css", None)

        if css is None:
            continue

        if type(css) is list:
            css = {"which": css}
        elif type(css) is not dict:
            raise ValueError(
                f"css sections should be a non-empty object or list or be removed from interventions in {src_json_filename}"
            )

        which_css_files_to_add = css.pop("which", None)
        if not which_css_files_to_add or type(which_css_files_to_add) is not list:
            raise ValueError(
                f"intervention with missing `which` key or invalid array of desired css files in {src_json_filename}"
            )

        for file in which_css_files_to_add:
            if type(file) is not str or not file:
                raise ValueError(
                    f"Empty or non-string filename not listed in intervention css section of {src_json_filename}"
                )
            if not css_files.get(file):
                raise ValueError(
                    f"{file} is not listed in css section of {src_json_filename}"
                )
            actually_used_files.add(file)

        metas = {}
        for key in VALID_META_KEYS:
            metas[key] = css.pop(key, False)
            if not isinstance(metas[key], bool):
                raise ValueError(
                    f"{key} must be `true` or `false` in {src_json_filename}"
                )

        unknown_keys = "','".join(css.keys())
        if unknown_keys:
            raise ValueError(
                f"unknown key(s) '{unknown_keys}' in css section of {src_json_filename}"
            )

        content_scripts = intervention.get("content_scripts", None)
        if content_scripts:
            for key in VALID_META_KEYS:
                if content_scripts.get(key, False) != metas[key]:
                    raise ValueError(
                        f"cannot mix value of {key} in css and content_scripts sections in {src_json_filename}"
                    )

        content_scripts = intervention.setdefault("content_scripts", {})

        css = content_scripts.setdefault("css", [])
        for filename in which_css_files_to_add:
            final_filename = safe_filename(f"bug{bug_number}-{label}-{filename}.css")
            css.append(f"injections/generated/{final_filename}")
            files_to_generate[final_filename] = css_files[filename]

        for key in VALID_META_KEYS:
            if metas[key]:
                content_scripts[key] = True

    extras = set(css_files.keys()).difference(actually_used_files)
    if extras:
        raise ValueError(
            f"Extra css fragments specified which aren't used in {src_json_filename}: "
            + ", ".join(list(extras))
        )

    return files_to_generate


def generate_run_js(
    output_fd,
    template_path,
    interventions_dir,
    *_preprocessed_intervention_files_mozbuild,
):
    preprocessed_intervention_files_mozbuild = [
        f for f in _preprocessed_intervention_files_mozbuild if f.endswith(".css")
    ]

    with open(template_path) as template_fd:
        input_files = list(FileFinder(interventions_dir).find("*.json"))

        filenames_json_files_expect_to_generate = set()

        final_interventions = {}
        actually_referenced_non_generated_files = set()
        for json_filename, json_fd in input_files:
            bug_number = mozpath.splitext(mozpath.basename(json_filename))[0].split(
                "-"
            )[0]

            try:
                config = json.load(json_fd)
            except json.decoder.JSONDecodeError as e:
                raise ValueError(f"{json_filename} is invalid JSON: {e}")

            final_interventions[bug_number] = config

            # Do some sanity checks first
            for intervention in config["interventions"]:
                content_scripts = intervention.get("content_scripts", {})
                for type in ["css", "js"]:
                    for non_generated_filename in content_scripts.get(type, []):
                        actually_referenced_non_generated_files.add(
                            non_generated_filename
                        )
                        actual_path = mozpath.normpath(
                            mozpath.join(
                                interventions_dir,
                                "..",
                                "..",
                                "injections",
                                type,
                                non_generated_filename,
                            )
                        )
                        if not os.path.isfile(actual_path) or not os.access(
                            actual_path, os.R_OK
                        ):
                            raise ValueError(
                                f"{actual_path} not an accessible file in {json_filename}"
                            )
                        if os.path.splitext(actual_path)[1] != "." + type:
                            raise ValueError(
                                f"File extension for {actual_path} should be .{type} in {json_filename}"
                            )

            # Now remove each css section in this JSON and ensure that a corresponding
            # content_scripts section exists, with the files named as they will be after
            # they are generated by generate_css_intervention. Also double-check that we
            # will not be stomping over any already-existing non-generated files.

            generated_files = determine_generated_content_scripts_for_intervention(
                config, bug_number, json_filename
            )

            for filename in generated_files:
                filenames_json_files_expect_to_generate.add(filename)

        # Halt if preprocessed_intervention_files.mozbuild needs to be updated
        filenames_listed_in_mozbuild = set(preprocessed_intervention_files_mozbuild)
        extra_generated_files = sorted(
            filenames_json_files_expect_to_generate.difference(
                filenames_listed_in_mozbuild
            )
        )
        missing_generated_files = sorted(
            filenames_listed_in_mozbuild.difference(
                filenames_json_files_expect_to_generate
            )
        )
        if extra_generated_files or missing_generated_files:
            msg = ""
            if missing_generated_files:
                msg += "\nPlease remove: " + ", ".join(missing_generated_files)
            if extra_generated_files:
                msg += "\nPlease add: " + ", ".join(extra_generated_files)
            raise ValueError(
                "preprocessed_intervention_files.mozbuild is out of date:" + msg
            )

        # Check if any non-generated css/js files aren't being used anymore.
        non_generated_files_path = mozpath.normpath(
            mozpath.join(interventions_dir, "..", "..", "injections")
        )
        non_generated_files = set(
            name
            for name, _ in FileFinder(
                mozpath.join(non_generated_files_path, "css")
            ).find("*")
        )
        non_generated_files.update(
            set(
                name
                for name, _ in FileFinder(
                    mozpath.join(non_generated_files_path, "js")
                ).find("*")
            )
        )
        extra_non_generated_files = sorted(
            non_generated_files.difference(actually_referenced_non_generated_files)
        )
        # Generic css/js files are bundled in case we need them for remote updates,
        # so don't ask for them to be removed even if they seem unreferenced.
        extra_non_generated_files = [
            filename
            for filename in extra_non_generated_files
            if filename.startswith("bug")
        ]
        if extra_non_generated_files:
            raise ValueError(
                "Please remove these files which are not referenced in any intervention JSON file: "
                + ", ".join(extra_non_generated_files)
            )

        # Emit the final run.json
        interventions_json = json.dumps(
            dict(sorted(final_interventions.items())), indent=2
        )

        raw = template_fd.read()
        subbed = raw.replace(
            "// Note that this variable is expanded during build-time. See bz2019069 for details.\n",
            "",
        )
        subbed = raw.replace(
            "AVAILABLE_INTERVENTIONS = {}",
            f"AVAILABLE_INTERVENTIONS = {interventions_json}",
        )
        output_fd.write(subbed)


def generate_file(outfile, interventions_dir, *ignored):
    desired_filename = mozpath.basename(outfile.name)
    if not outfile.name.endswith(".css"):
        raise ValueError(f"Do not know how to generate {outfile.name}")

    try:
        bug_number = re.search(r"bug(\d+)", desired_filename)[1]
    except Exception:
        raise ValueError(f"Could not determine bug number from {outfile.name}")

    json_files = list(FileFinder(interventions_dir).find(f"{bug_number}*.json"))
    if not json_files:
        raise ValueError(f"no json intervention file starting with {bug_number}")
    if len(json_files) > 1:
        json_files = ", ".join([f[0] for f in json_files])
        raise ValueError(
            f"multiple json intervention files starting with {bug_number}.. not sure which to use from {json_files}"
        )

    json_filename, json_fd = json_files[0]
    try:
        config = json.load(json_fd)
    except json.decoder.JSONDecodeError as e:
        raise ValueError(f"{json_filename} is invalid JSON: {e}")

    generated_files = determine_generated_content_scripts_for_intervention(
        config, bug_number, json_filename
    )

    file_contents = generated_files.get(desired_filename, None)

    if file_contents is None:
        raise ValueError(
            f"No file contents found to generate {desired_filename} for {json_filename}"
        )

    outfile.write(
        "/* THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY. */\n\n"
    )
    outfile.write(file_contents)


def main(*args):  # mach requires this
    pass
