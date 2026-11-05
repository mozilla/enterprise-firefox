# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

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


MAR_KIND = "enterprise-repack-repackage-signing"


def mar_signing_task(build_platform, repack_config, locales, published=None):
    """Signs the MARs the repack produced, one per locale, under the repack.

    ``published`` lets a test publish a different set than the repack asked
    for, which is how the artifact lookup gets exercised.
    """
    return Task(
        kind=MAR_KIND,
        label=f"{MAR_KIND}-{repack_config.replace('/', '_')}-{build_platform}/opt",
        attributes={
            "build_platform": build_platform,
            "artifact_prefix": REPACK_PREFIX,
            "release_artifacts": [
                f"{REPACK_PREFIX}/{repack_config}/{locale}/target.complete.mar"
                for locale in (locales if published is None else published)
            ],
        },
        task={"extra": {"repack_config": repack_config, "repack_locales": locales}},
    )


def make_deps(
    repack_configs=(REPACK_CONFIG,), locales=LOCALES, mar_locales=None, skip_mar=()
):
    deps = []
    for repack_config in repack_configs:
        deps += [installer_task(kind, repack_config, locales) for kind in INSTALLERS]
        for build_platform, _ in INSTALLERS.values():
            if build_platform in skip_mar:
                continue
            deps.append(
                mar_signing_task(
                    build_platform, repack_config, locales, published=mar_locales
                )
            )
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


def test_the_mar_comes_from_the_repack_not_the_generic_build():
    """The console must get the repacked MAR, whose `firefox.cfg` names the
    customer's console. The generic build's MAR carries a placeholder instead
    (bug 2072087), so the path has to be under the repack config."""
    variants, labels = erd._collect_releases(make_deps())[REPACK_CONFIG]

    for locale in LOCALES:
        url = variants[("Linux_x86_64-gcc3", locale)]["complete_mar"]
        assert f"<{MAR_KIND}-moz_stageGCP-linux64-enterprise-shippable/opt>" in url
        assert url.endswith(
            f"{REPACK_PREFIX}/{REPACK_CONFIG}/{locale}/target.complete.mar"
        )
    assert not [label for label in labels if label.startswith("mar-signing")]


def test_locales_outside_the_repack_are_ignored():
    """Only the locales the repack asked for become variants, even if a task
    published more."""
    variants, _ = erd._collect_releases(make_deps(mar_locales=LOCALES + ["ja", "pl"]))[
        REPACK_CONFIG
    ]

    assert {locale for _, locale in variants} == set(LOCALES)


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
    """A missing MAR degrades that variant rather than dropping it or
    inventing a URL."""
    variants, _ = erd._collect_releases(make_deps(mar_locales=["de", "en-US"]))[
        REPACK_CONFIG
    ]

    assert sorted(variants[("Linux_x86_64-gcc3", "fr")]) == ["linux_deb"]
    assert sorted(variants[("Linux_x86_64-gcc3", "de")]) == [
        "complete_mar",
        "linux_deb",
    ]


def test_a_platform_without_a_mar_task_has_no_mar():
    """MAR signing is per repack and per platform, so one platform missing it
    does not cost the others theirs."""
    variants, _ = erd._collect_releases(
        make_deps(skip_mar=("win64-enterprise-shippable",))
    )[REPACK_CONFIG]

    for locale in LOCALES:
        assert sorted(variants[("WINNT_x86_64-msvc", locale)]) == ["windows_msi"]
        assert "complete_mar" in variants[("Linux_x86_64-gcc3", locale)]


if __name__ == "__main__":
    main()
