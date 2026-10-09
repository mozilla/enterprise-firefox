# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import pytest
from mozunit import main
from taskgraph.task import Task

from gecko_taskgraph.transforms import enterprise_release_definition as erd

REPACK_CONFIG = "moz/stageGCP"
OTHER_REPACK_CONFIG = "moz/prodGCP"
LOCALES = ["de", "en-US", "fr"]
REPACK_PREFIX = "project/enterprise/repacks"

# The per-repack kinds, as `{kind: (build_platform, artifact path template)}`.
# Paths mirror what each kind publishes, so `_artifact_path` resolves them.
INSTALLERS = {
    "repackage-deb": ("linux64-enterprise-shippable", "{prefix}/{locale}/target.deb"),
    "repackage-signing-msi": (
        "win64-enterprise-shippable",
        "{prefix}/{locale}/target.installer.msi",
    ),
    "enterprise-repack-mac-notarization": (
        "macosx64-enterprise-shippable",
        "{prefix}/{repack_config}/{locale}/target.pkg",
    ),
}

BLOB_OF_TARGET = {
    "Linux_x86_64-gcc3": "linux_deb",
    "WINNT_x86_64-msvc": "windows_msi",
    "Darwin_aarch64-gcc3": "macos_pkg",
}


def installer_task(kind, repack_config, locales):
    build_platform, template = INSTALLERS[kind]
    return Task(
        kind=kind,
        label=f"{kind}-{repack_config.replace('/', '_')}-{build_platform}/opt",
        attributes={
            "build_platform": build_platform,
            "artifact_prefix": REPACK_PREFIX,
            "release_artifacts": [
                template.format(
                    prefix=REPACK_PREFIX, repack_config=repack_config, locale=locale
                )
                for locale in locales
            ],
        },
        task={"extra": {"repack_config": repack_config, "repack_locales": locales}},
    )


def mar_signing_task(build_platform):
    """Signs the en-US MAR only, and publishes it at the root."""
    return Task(
        kind="mar-signing",
        label=f"mar-signing-{build_platform}/opt",
        attributes={
            "build_platform": build_platform,
            "release_artifacts": ["public/build/target.complete.mar"],
        },
        task={"extra": {}},
    )


def mar_signing_l10n_task(build_platform, locale):
    return Task(
        kind="mar-signing-l10n",
        label=f"mar-signing-l10n-{locale}-{build_platform}/opt",
        attributes={
            "build_platform": build_platform,
            "release_artifacts": [f"public/build/{locale}/target.complete.mar"],
        },
        task={"extra": {}},
    )


def make_deps(repack_configs=(REPACK_CONFIG,), locales=LOCALES, extra_locales=()):
    deps = []
    for repack_config in repack_configs:
        deps += [installer_task(kind, repack_config, locales) for kind in INSTALLERS]
    for build_platform, _ in INSTALLERS.values():
        deps.append(mar_signing_task(build_platform))
        for locale in [l for l in locales if l != "en-US"] + list(extra_locales):
            deps.append(mar_signing_l10n_task(build_platform, locale))
    return deps


def test_every_requested_locale_gets_an_installer_and_a_mar():
    """The upload has to carry the whole repack: one variant per locale per
    build target, each with its platform's installer and its MAR."""
    releases = erd._collect_releases(make_deps())

    assert sorted(releases) == [REPACK_CONFIG]
    variants, _ = releases[REPACK_CONFIG]

    assert sorted(variants) == sorted(
        (target, locale) for target in BLOB_OF_TARGET for locale in LOCALES
    )
    for (build_target, locale), blobs in variants.items():
        assert sorted(blobs) == sorted([
            "complete_mar",
            BLOB_OF_TARGET[build_target],
        ]), f"{build_target}/{locale}"


def test_en_us_and_localized_mars_come_from_their_own_kinds():
    """`mar-signing` publishes the en-US MAR at the root and `mar-signing-l10n`
    publishes one per locale. The en-US path must not be handed to the other
    locales, which it would be if the spec stopped checking the locale."""
    variants, _ = erd._collect_releases(make_deps())[REPACK_CONFIG]

    assert variants[("Linux_x86_64-gcc3", "en-US")]["complete_mar"].endswith(
        "<mar-signing-linux64-enterprise-shippable/opt>"
        "/artifacts/public/build/target.complete.mar"
    )
    for locale in ("de", "fr"):
        url = variants[("Linux_x86_64-gcc3", locale)]["complete_mar"]
        assert f"mar-signing-l10n-{locale}-linux64-enterprise-shippable" in url
        assert url.endswith(f"public/build/{locale}/target.complete.mar")


def test_locales_outside_the_repack_are_ignored():
    """A MAR signing task exists per locale the build ships, which is a
    superset of what a repack asks for."""
    variants, labels = erd._collect_releases(make_deps(extra_locales=("ja", "pl")))[
        REPACK_CONFIG
    ]

    assert {locale for _, locale in variants} == set(LOCALES)
    assert not [label for label in labels if "-ja-" in label or "-pl-" in label]


def test_releases_do_not_leak_across_repacks():
    releases = erd._collect_releases(
        make_deps(repack_configs=(REPACK_CONFIG, OTHER_REPACK_CONFIG))
    )

    assert sorted(releases) == sorted([REPACK_CONFIG, OTHER_REPACK_CONFIG])
    for repack_config, (variants, labels) in releases.items():
        other = OTHER_REPACK_CONFIG if repack_config == REPACK_CONFIG else REPACK_CONFIG
        assert len(variants) == len(BLOB_OF_TARGET) * len(LOCALES)
        assert not [label for label in labels if other.replace("/", "_") in label]


def test_a_locale_with_no_mar_still_ships_its_installer():
    """A variant exists because a per-repack artifact backs it; a missing MAR
    degrades that variant rather than dropping it or inventing a URL."""
    deps = [
        dep
        for dep in make_deps()
        if not (dep.kind == "mar-signing-l10n" and "-fr-" in dep.label)
    ]
    variants, _ = erd._collect_releases(deps)[REPACK_CONFIG]

    assert sorted(variants[("Linux_x86_64-gcc3", "fr")]) == ["linux_deb"]
    assert sorted(variants[("Linux_x86_64-gcc3", "de")]) == [
        "complete_mar",
        "linux_deb",
    ]


@pytest.mark.parametrize("kind", sorted(INSTALLERS))
def test_mar_signing_alone_never_creates_a_variant(kind):
    """MAR signing is shared by every repack of a platform, so it can only
    attach to variants a per-repack artifact already created."""
    deps = [
        dep for dep in make_deps() if dep.kind not in INSTALLERS or dep.kind == kind
    ]
    variants, _ = erd._collect_releases(deps)[REPACK_CONFIG]

    build_platform, _ = INSTALLERS[kind]
    target = erd.ENTERPRISE_PLATFORM_MAP[build_platform]
    assert {t for t, _ in variants} == {target}


if __name__ == "__main__":
    main()
