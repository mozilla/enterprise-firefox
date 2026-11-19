# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import sys
from os import path

import mozunit

# Shenanigans to import the metrics index's lists of yamls
FOG_ROOT_PATH = path.abspath(
    path.join(path.dirname(__file__), path.pardir, path.pardir)
)
sys.path.append(FOG_ROOT_PATH)
import metrics_index


def test_yamls_sorted():
    """
    Ensure the yamls indices are sorted lexicographically.
    """
    # Ignore lists that are the concatenation of others.
    to_ignore = ["metrics_yamls", "pings_yamls"]

    # Fetch names of all variables defined in the `metrics_index` module.
    yaml_lists = [
        item
        for item in dir(metrics_index)
        if isinstance(getattr(metrics_index, item), list) and not item.startswith("__")
    ]
    for name in yaml_lists:
        if name in to_ignore:
            continue

        yamls_to_test = metrics_index.__dict__[name]
        assert sorted(yamls_to_test) == yamls_to_test, (
            f"{name} must be be lexicographically sorted."
        )


def test_no_metrics_file_duplicated():
    """
    When metrics files are listed in both `gecko_metrics` and one of the applications,
    they are duplicated and that will lead to problems in probe-scraper.

    They should only be listed in one of them.
    """

    gecko_metrics = set(metrics_index.gecko_metrics)

    others = [
        "firefox_desktop_metrics",
        "background_update_metrics",
        "background_tasks_metrics",
    ]

    for other in others:
        other_metrics = set(getattr(metrics_index, other))
        in_both = gecko_metrics & other_metrics

        assert not in_both, (
            f"Files duplicated in both gecko_metrics and {other} are not allowed"
        )


def test_no_pings_file_duplicated():
    """
    When ping files are listed in both `gecko_metrics` and one of the applications,
    and that will lead to problems in probe-scraper.

    They should only be listed in one of them.
    """

    gecko_pings = set(metrics_index.gecko_pings)

    others = [
        "firefox_desktop_pings",
        "background_update_pings",
        "background_tasks_pings",
    ]

    for other in others:
        other_pings = set(getattr(metrics_index, other))
        in_both = gecko_pings & other_pings

        assert not in_both, (
            f"Files duplicated in both gecko_pings and {other} are not allowed"
        )


def test_enterprise_files_not_in_regular_builds():
    """
    Enterprise metrics and pings files must never be built into regular
    Firefox, so they must only be listed in the enterprise lists.
    """

    enterprise_yamls = set(
        metrics_index.firefox_enterprise_metrics
        + metrics_index.firefox_enterprise_pings
    )

    for yaml in enterprise_yamls:
        assert path.basename(yaml) in (
            "enterprise_metrics.yaml",
            "enterprise_pings.yaml",
        ), f"{yaml} must be named enterprise_metrics.yaml or enterprise_pings.yaml"

    regular_yamls = set(metrics_index.metrics_yamls + metrics_index.pings_yamls)
    for ping_yamls in metrics_index.pings_by_app_or_lib_id.values():
        regular_yamls.update(ping_yamls)

    in_both = enterprise_yamls & regular_yamls
    assert not in_both, (
        f"Enterprise files {sorted(in_both)} must not be listed outside of "
        "firefox_enterprise_metrics and firefox_enterprise_pings"
    )

    overridden_app_ids = set(metrics_index.enterprise_pings_by_app_id) & set(
        metrics_index.pings_by_app_or_lib_id
    )
    assert not overridden_app_ids, (
        f"Enterprise app ids {sorted(overridden_app_ids)} must not override "
        "regular app ids in pings_by_app_or_lib_id"
    )


if __name__ == "__main__":
    mozunit.main()
