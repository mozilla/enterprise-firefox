# Working with Strings

## Removing unused strings

Android projects are localized through [Pontoon](https://pontoon.mozilla.org/), which relies on an external GitHub repository called [android-l10n](https://github.com/mozilla-l10n/android-l10n).

This repository automatically includes strings for all supported versions of Android projects (Nightly, Beta, Release), importing them from the respective branches (`main`, `beta`, `release`). That means engineers can safely remove strings rendered unused when landing code to `main`.

## Making changes to existing strings

These are the general guidelines to follow when updating existing strings already exposed for localization:

- If you are changing a string such that its meaning has changed, you must update the string ID.
- If your changes are relevant only for English — for example, to correct a typographical error or to make capitalization consistent — then there is no need to update the string ID.

There is a gray area between needing a new ID or not. In some cases, it will be necessary to look at all the existing translations to determine if a new ID would be beneficial. You should always reach out to the localization team in case of doubt.

For more information, see [this document](https://mozilla-l10n.github.io/documentation/localization/making_string_changes.html#why-is-it-necessary-to-use-new-ids) explaining why new string IDs are required.

## Prelanding strings

It is possible to preland strings to gain more time for localization. In these cases, make sure to provide additional context in the patch (e.g. Figma designs or screenshots), as localizers may need screenshots or designs to understand the context.

If the prelanded strings are not yet referenced by any code, also add `tools:ignore="UnusedResources"`. Note that this is enforced through a [linter](https://firefox-source-docs.mozilla.org/code-quality/lint/linters/android-expired-strings.html). For example:

```xml
<string name="new_feature_title" tools:ignore="UnusedResources">New Feature</string>
```

## Hard-coding strings

It’s possible to temporarily hard-code strings in English, for example if the content is being finalized or if the feature is only available in English. Android products can load arbitrary XML files from the `values` folder, while the localization infrastructure is set up to only look at `values/strings.xml` (via `l10n.toml` [configuration files](https://github.com/mozilla/moz-l10n/wiki/L10nConfigPaths-file-format)). Typically, a file called `static_strings.xml` can be used to hard-code English strings.

## Editing localized files

Localized files live in `values-$LOCALE` folders (e.g. `values-fr` for French). They should not be edited directly, since automation will overwrite these changes every 24h (it only runs from `android-l10n` to the Firefox repository). If you spot errors and need to make changes, get in touch with the [localization project manager](https://mozilla-l10n.github.io/localizer-documentation/products/l10n_project_managers.html) in charge of Android projects.

If you’re completely removing a `strings.xml` file, file a follow-up bug to remove all localized files once the English file removal has landed in the `android-l10n` repository. The automation only syncs from `android-l10n` to Firefox and does not remove obsolete files.

## Additional documentation

- [android-l10n docs](https://mozilla-l10n.github.io/documentation/products/android-l10n/index.html)
- [Firefox Mobile L10N FAQs](https://mozilla-l10n.github.io/documentation/products/mobile/mobile_l10n_faqs.html)
