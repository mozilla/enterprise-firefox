# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""
Apply the settings that only the enterprise CI needs to tasks whose
definitions are shared with upstream as transform to avoid merge conflicts
"""

from taskgraph.transforms.base import TransformSequence
from taskgraph.util.yaml import load_yaml

transforms = TransformSequence()

OVERRIDES_FILE = "enterprise-overrides.yml"


def apply_override(task, override):
    """Merge `override` into `task`: dicts are merged recursively, list items
    are appended unless already present, other values are replaced, and a
    null value removes the key."""
    for key, value in override.items():
        if value is None:
            task.pop(key, None)
        elif isinstance(value, dict):
            apply_override(task.setdefault(key, {}), value)
        elif isinstance(value, list):
            current = task.setdefault(key, [])
            current.extend(item for item in value if item not in current)
        else:
            task[key] = value


@transforms.add
def apply_enterprise_overrides(config, tasks):
    overrides = load_yaml(config.path, OVERRIDES_FILE)
    tasks = list(tasks)
    unknown = set(overrides) - {task["name"] for task in tasks}
    if unknown:
        raise Exception(
            f"{OVERRIDES_FILE} of kind {config.kind} names unknown tasks: "
            f"{', '.join(sorted(unknown))}"
        )
    for task in tasks:
        apply_override(task, overrides.get(task["name"], {}))
        yield task
