# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import json
import pathlib

import jsonschema
from mozlint import result

META_SCHEMA_REL = (
    "browser/components/enterprisepolicies/schemas/policies-schema.meta.json"
)
# Resolve relative to this file rather than lintargs["root"], so the linter
# and its tests share a single source-of-truth meta-schema.
META_SCHEMA_PATH = pathlib.Path(__file__).resolve().parents[3] / META_SCHEMA_REL


def _load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _locate_lineno(text, json_path):
    """Locate the source line for a jsonschema validation error.

    Returns the line of the top-level policy entry under `properties` that
    the error is about, or 1 for root-level errors.
    """
    parts = list(json_path)
    if len(parts) >= 2 and parts[0] == "properties":
        needle = f'"{parts[1]}":'
        for lineno, line in enumerate(text.splitlines(), start=1):
            if needle in line:
                return lineno
    return 1


def _error(config, path, lineno, message):
    return result.from_config(
        config,
        path=str(path),
        lineno=lineno,
        message=message,
        level="error",
    )


def lint(paths, config, **lintargs):
    try:
        meta_schema = _load_json(META_SCHEMA_PATH)
    except (OSError, json.JSONDecodeError) as e:
        return [
            _error(
                config,
                META_SCHEMA_PATH,
                1,
                f"Could not load meta-schema: {e}",
            )
        ]

    validator = jsonschema.Draft7Validator(meta_schema)
    results = []

    for path in paths:
        path = pathlib.Path(path)
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
            data = json.loads(text)
        except json.JSONDecodeError as e:
            results.append(_error(config, path, e.lineno, f"Invalid JSON: {e.msg}"))
            continue
        except OSError as e:
            results.append(_error(config, path, 1, f"Could not read file: {e}"))
            continue

        for err in sorted(validator.iter_errors(data), key=lambda e: list(e.path)):
            location = "/".join(str(p) for p in err.absolute_path) or "<root>"
            message = f"{location}: {err.message}"
            results.append(
                _error(config, path, _locate_lineno(text, err.absolute_path), message)
            )

    return results
