# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import filters
from base_python_support import BasePythonSupport
from logger.logger import RaptorLogger
from utils import flatten

LOG = RaptorLogger(component="raptor-speedometer3-support")


class Speedometer3Support(BasePythonSupport):
    def handle_result(self, bt_result, raw_result, **kwargs):
        """Parse Speedometer 3 results."""

        for result in raw_result["extras"]:
            overall_score = round(result["s3"]["score"]["mean"], 3)
            measurements = {}

            subtest_summary = result.get("s3_subtests_summary", {})
            for metric_name, metric_value in subtest_summary.items():
                measurements[metric_name] = [round(float(metric_value), 3)]

            flattened_internal = flatten(result.get("s3_internal", []), ())
            total_values = flattened_internal.get("total", [])

            if total_values:
                derived_total_mean = sum(total_values) / len(total_values)
                measurements["total"] = [round(derived_total_mean, 3)]

            measurements["score"] = [overall_score]

            for name, values in measurements.items():
                bt_result["measurements"].setdefault(name, []).extend(values)

    def _build_subtest(self, measurement_name, replicates, test):
        unit = test.get("unit", "ms")
        if test.get("subtest_unit"):
            unit = test.get("subtest_unit")

        lower_is_better = test.get(
            "subtest_lower_is_better", test.get("lower_is_better", True)
        )
        if "score" in measurement_name:
            lower_is_better = False
            unit = "score"

        subtest = {
            "unit": unit,
            "alertThreshold": float(test.get("alert_threshold", 2.0)),
            "lowerIsBetter": lower_is_better,
            "name": measurement_name,
            "replicates": replicates,
            "shouldAlert": True,
            "value": round(filters.mean(replicates), 3),
        }

        if "score-internal" in measurement_name:
            subtest["shouldAlert"] = False

        return subtest

    def summarize_test(self, test, suite, **kwargs):
        """Summarize the measurements found in the test as a suite with subtests.

        See base_python_support.py for what's expected from this method.
        """
        suite["type"] = "benchmark"
        if suite["subtests"] == {}:
            suite["subtests"] = []
        for measurement_name, replicates in test["measurements"].items():
            if not replicates:
                continue
            if self.is_additional_metric(measurement_name):
                continue
            suite["subtests"].append(
                self._build_subtest(measurement_name, replicates, test)
            )

        self.add_additional_metrics(test, suite, **kwargs)
        suite["subtests"].sort(key=lambda subtest: subtest["name"])

        score = 0
        replicates = []
        for subtest in suite["subtests"]:
            if subtest["name"] == "score":
                score = subtest["value"]
                replicates = subtest.get("replicates", [])
                break
        suite["value"] = score
        suite["replicates"] = replicates

    def modify_command(self, cmd, test):
        """Modify the browsertime command for speedometer 3.

        Presently we need to modify the commend to accommodate profiling
        on android devices by modifying the test url to lower the iteration
        counts.

        """

        # Bug 1934266
        # For profiling on android + speedometer3 we set the iteration count to 5.
        # Otherwise the profiles are too large and use too much of the allocated
        # host machine memory. This is a useful temporary measure until we have
        # a more long term solution.
        if test.get("gecko_profile", False) and self.app in ("fenix", "geckoview"):
            LOG.info(
                "Modifying iterationCount to 5 for gecko profiling speedometer3 on android"
            )
            btime_url_index = cmd.index("--browsertime.url")
            cmd[btime_url_index + 1] += "&iterationCount=5"
