# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import unittest

from mozunit import main

from gecko_taskgraph.util.partners import parse_config, parse_registry_reference

PLATFORM_MAPPING = {
    "linux-x86_64": "linux64-enterprise-shippable",
    "mac": "macosx64-enterprise-shippable",
    "win64": "win64-enterprise-shippable",
    "win64-aarch64": "win64-aarch64-enterprise-shippable",
}


class TestParseRegistryReference(unittest.TestCase):
    def test_bare_reference(self):
        self.assertEqual(
            parse_registry_reference("registry.example.com/mozilla/firefox"),
            "https://registry.example.com/mozilla/firefox",
        )

    def test_bare_reference_with_port(self):
        self.assertEqual(
            parse_registry_reference("registry.example.com:5000/mozilla/firefox"),
            "https://registry.example.com:5000/mozilla/firefox",
        )

    def test_https_url(self):
        self.assertEqual(
            parse_registry_reference("https://registry.example.com/mozilla/firefox"),
            "https://registry.example.com/mozilla/firefox",
        )

    def test_rejects_other_schemes(self):
        for value in ("http://registry.example.com/mozilla", "ftp://example.com/x"):
            with self.assertRaises(RuntimeError):
                parse_registry_reference(value)


class TestParseConfig(unittest.TestCase):
    def test_registry_reference(self):
        config = parse_config(
            'locales="en-US fr"\n'
            "linux-i686=false\n"
            "linux-x86_64=true\n"
            "mac=true\n"
            "win32=false\n"
            "win64=true\n"
            "win64-aarch64=true\n"
            'registry_reference="registry.example.com/mozilla/firefox"\n',
            PLATFORM_MAPPING,
        )
        self.assertEqual(
            config,
            {
                "locales": ["en-US", "fr"],
                "platforms": [
                    "linux64-enterprise-shippable",
                    "macosx64-enterprise-shippable",
                    "win64-enterprise-shippable",
                    "win64-aarch64-enterprise-shippable",
                ],
                "registry_reference": "https://registry.example.com/mozilla/firefox",
            },
        )

    def test_without_registry_reference(self):
        config = parse_config('locales="en-US"\nwin64=true\n', PLATFORM_MAPPING)
        self.assertNotIn("registry_reference", config)


if __name__ == "__main__":
    main()
