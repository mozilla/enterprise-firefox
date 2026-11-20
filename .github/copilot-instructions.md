# Copilot instructions for mozilla/enterprise-firefox

This repository is Firefox Enterprise, a downstream of Firefox. Most code comes from upstream, where it has already been reviewed.

- Enterprise-specific code: `browser/branding/enterprise/`, `browser/components/enterprise/`, `toolkit/components/enterprise/`, `toolkit/components/felt/`, `testing/enterprise/`.
- Shared code with Enterprise changes: `browser/components/enterprisepolicies/`, `toolkit/components/enterprisepolicies/`, Enterprise parts of `taskcluster/`, and code guarded by `MOZ_ENTERPRISE` or `AppConstants.MOZ_ENTERPRISE`.

## General

Do not invent findings. Do not use emoji.

## Merge and promotion pull requests

- **Promotions** (description says "Promote `enterprise-main` to `enterprise-beta`" or "Promote `enterprise-beta` to `enterprise-release`"): do not review. Post no comments and no overview.
- **Daily merges** (description says "Daily merge from `<source>` to `enterprise-main`", `enterprise-beta` or `enterprise-release`): review only the files listed under "Resolved conflicts:". If the description says "No merge conflicts.", do not review. Ignore all other files, and do not summarize upstream changes. In the resolved files, check that:
  - both the Enterprise and the upstream changes are kept. If one side's change was dropped, only flag it if it seems unintentional;
  - no conflict markers remain;
  - nothing is duplicated;
  - the result is consistent with the surrounding code.

## Other pull requests

Review all other pull requests normally.
