# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import buildconfig

# Byte shift value applied to AutoConfig files. Must match the default of the
# general.config.obscure_value preference, which the browser subtracts when
# reading the file, and DEFAULT_OBSCURE_VALUE in the enterprise-console crate
# (toolkit/components/enterprise/rust), which decodes the file for the early
# startup and crash reporter consumers. The generic console address
# placeholder below is CONSOLE_ADDRESS_PLACEHOLDER in that crate.
OBSCURE_VALUE = 13


def generate(output, input_path):
    """GENERATED_FILES action: write `input_path` byte shifted by OBSCURE_VALUE.

    `@MOZ_ENTERPRISE_CONSOLE_URL@` is replaced by the value of
    --enable-enterprise-console before shifting. Reading it through
    `buildconfig` (rather than a GENERATED_FILES flag) makes the build system
    record a dependency on that single subst, so the file is regenerated when
    the URL changes. `output` is a binary file object provided by the build
    system.
    """
    with open(input_path, "rb") as fh:
        data = fh.read()
    console_url = buildconfig.substs["MOZ_ENTERPRISE_CONSOLE_URL"]
    data = data.replace(b"@MOZ_ENTERPRISE_CONSOLE_URL@", console_url.encode("utf-8"))
    output.write(bytes((byte + OBSCURE_VALUE) & 0xFF for byte in data))
