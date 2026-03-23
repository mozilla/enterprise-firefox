from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from buildconfig import config, topsrcdir
from glean_parser import parser
from jsonschema import Draft202012Validator

TOP_SRC_DIR = Path(topsrcdir)

V2_RESOLVED_FILE_FORMAT = "resolved/2.0.0"
V2_MANIFEST_FILE_FORMAT = "manifest/2.0.0"
SCHEMA_URL = "https://mozilla.org/schemas/glean/semconv"

SCHEMA_PATH = Path(__file__).parent / "schemas" / "semconv.resolved.v2.json"
MANIFEST_SCHEMA_PATH = (
    Path(__file__).parent / "schemas" / "publication-manifest.v2.json"
)

GLEAN_TYPE_TO_OTEL_TYPE = {
    "string": "string",
    "boolean": "boolean",
    "quantity": "int",
    "counter": "int",
    "timespan": "int",
    "timing_distribution": "int",
    "memory_distribution": "int",
    "custom_distribution": "int",
    "rate": "double",
    "uuid": "string",
    "url": "string",
    "datetime": "string",
    "text": "string",
    "object": "string",
    "denominator": "int",
    "labeled_boolean": "boolean",
    "labeled_string": "string",
    "labeled_counter": "int",
    "string_list": "string[]",
}


@dataclass
class CatalogAttribute:
    key: str
    type: str
    brief: str
    stability: str = "development"
    note: str | None = None

    def to_dict(self) -> dict:
        d: dict = {
            "key": self.key,
            "type": self.type,
            "brief": self.brief,
            "stability": self.stability,
        }
        if self.note:
            d["note"] = self.note
        return d


class AttributeCatalog:
    def __init__(self):
        self._attrs: list[CatalogAttribute] = []
        self._index: dict[str, int] = {}

    def get_or_add(self, attr: CatalogAttribute) -> int:
        if attr.key in self._index:
            return self._index[attr.key]
        idx = len(self._attrs)
        self._attrs.append(attr)
        self._index[attr.key] = idx
        return idx

    def to_list(self) -> list[dict]:
        return [a.to_dict() for a in self._attrs]

    def all_indices(self) -> list[int]:
        return list(range(len(self._attrs)))


@dataclass
class EventAttributeRef:
    base: int
    requirement_level: str = "recommended"

    def to_dict(self) -> dict:
        return {
            "base": self.base,
            "requirement_level": self.requirement_level,
        }


@dataclass
class OtelEvent:
    name: str
    brief: str
    stability: str = "development"
    note: str = ""
    attributes: list[EventAttributeRef] = field(default_factory=list)

    def to_registry_dict(self) -> dict:
        d: dict = {
            "name": self.name,
            "brief": self.brief,
            "stability": self.stability,
        }
        if self.note:
            d["note"] = self.note
        if self.attributes:
            d["attributes"] = [a.to_dict() for a in self.attributes]
        return d


def run(output_dir: Path | None = None):
    input_files = load_metrics_index()

    moz_app_version = config.substs.get("MOZ_APP_VERSION", "1")
    app_version_major = moz_app_version.split(".", 1)[0]

    res = parser.parse_objects(
        input_files,
        {"expire_by_version": int(app_version_major), "interesting": input_files},
    )

    for err in res:
        print(err)
    objs = res.value

    catalog, events = convert_glean_events(objs)
    resolved = build_resolved_registry(catalog, events)

    errors = validate_against_schema(resolved, SCHEMA_PATH)
    if errors:
        print(
            f"Resolved schema validation found {len(errors)} error(s):",
            file=sys.stderr,
        )
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    print(
        f"Schema validation passed. {len(events)} events converted, {len(catalog.to_list())} attributes cataloged."
    )

    if output_dir is None:
        output_dir = (
            TOP_SRC_DIR
            / "toolkit"
            / "components"
            / "glean"
            / "build_scripts"
            / "semconv"
            / "output"
        )

    output_dir.mkdir(parents=True, exist_ok=True)

    resolved_path = output_dir / "resolved.yaml"
    manifest_path = output_dir / "manifest.yaml"

    manifest = build_manifest(resolved_path.name)

    with open(resolved_path, "w") as f:
        yaml.dump(
            resolved, f, default_flow_style=False, sort_keys=False, allow_unicode=True
        )

    with open(manifest_path, "w") as f:
        yaml.dump(
            manifest, f, default_flow_style=False, sort_keys=False, allow_unicode=True
        )

    manifest_errors = validate_against_schema(manifest, MANIFEST_SCHEMA_PATH)
    if manifest_errors:
        print(
            f"Manifest schema validation found {len(manifest_errors)} error(s):",
            file=sys.stderr,
        )
        for e in manifest_errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Wrote {resolved_path}")
    print(f"Wrote {manifest_path}")


def load_metrics_index():
    index = TOP_SRC_DIR / "toolkit" / "components" / "glean" / "metrics_index.py"

    with open(index) as f:
        index_src = f.read()

    namespace = {}
    exec(index_src, namespace)

    return [TOP_SRC_DIR / x for x in namespace["metrics_yamls"]]


def convert_glean_events(objs) -> tuple[AttributeCatalog, list[OtelEvent]]:
    catalog = AttributeCatalog()
    events: list[OtelEvent] = []

    for category_name, category_metrics in sorted(objs.items()):
        for metric in sorted(category_metrics.values(), key=lambda m: m.identifier()):
            if metric.type != "event":
                continue

            event_name = metric.identifier()
            brief = metric.description.strip() if metric.description else event_name

            attr_refs: list[EventAttributeRef] = []
            if hasattr(metric, "extra_keys") and metric.extra_keys:
                for key_name, key_info in sorted(metric.extra_keys.items()):
                    glean_type = (
                        key_info.get("type", "string")
                        if isinstance(key_info, dict)
                        else "string"
                    )
                    otel_type = glean_extra_key_type_to_otel(glean_type)
                    key_desc = ""
                    if isinstance(key_info, dict):
                        key_desc = key_info.get("description", "").strip()

                    attr_key = f"{event_name}.{key_name}"
                    cat_attr = CatalogAttribute(
                        key=attr_key,
                        type=otel_type,
                        brief=key_desc or attr_key,
                        stability="development",
                    )
                    idx = catalog.get_or_add(cat_attr)
                    attr_refs.append(
                        EventAttributeRef(base=idx, requirement_level="recommended")
                    )

            otel_event = OtelEvent(
                name=event_name,
                brief=brief,
                stability="development",
                attributes=attr_refs,
            )
            events.append(otel_event)

    return catalog, events


def glean_extra_key_type_to_otel(glean_type: str) -> str:
    return GLEAN_TYPE_TO_OTEL_TYPE.get(glean_type, "string")


def build_resolved_registry(catalog: AttributeCatalog, events: list[OtelEvent]):
    registry_events = [e.to_registry_dict() for e in events]

    return {
        "file_format": V2_RESOLVED_FILE_FORMAT,
        "schema_url": {"url": SCHEMA_URL},
        "attribute_catalog": catalog.to_list(),
        "registry": {
            "attributes": catalog.all_indices(),
            "attribute_groups": [],
            "spans": [],
            "metrics": [],
            "events": registry_events,
            "entities": [],
        },
        "refinements": {
            "spans": [],
            "metrics": [],
            "events": [],
        },
    }


def validate_against_schema(instance, schema_path: Path) -> list[str]:
    if not schema_path.exists():
        return [f"Schema file not found: {schema_path}"]

    with open(schema_path) as f:
        schema = json.load(f)

    validator = Draft202012Validator(schema)
    errors = []
    for error in sorted(
        validator.iter_errors(instance), key=lambda e: list(e.absolute_path)
    ):
        errors.append(
            f"{'.'.join(str(p) for p in error.absolute_path)}: {error.message}"
        )
    return errors


def build_manifest(resolved_schema_uri: str) -> dict:
    return {
        "file_format": V2_MANIFEST_FILE_FORMAT,
        "schema_url": {"url": SCHEMA_URL},
        "resolved_schema_uri": resolved_schema_uri,
        "stability": "development",
    }
