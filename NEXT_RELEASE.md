# StreamTrust 0.6.2 release preparation

Patch release candidate; not published. Fixes LibreChat model-menu accessible-name matching and waits for selection readiness. Scenario names, lifecycle assertions and the default upstream pin are unchanged.

Local validation: 21 core tests passed; four browser regression cases passed against the generated tarball preset. Restoring the old exact selectors makes the browser suite fail. The packed 0.6.2 candidate passed all four scenarios three times (12/12, exit 0) on clean LibreChat v0.8.9 commit `d4e85d2205c78413ee27d631d7e3b7313556f21d`, with Node 24.22.1, Chromium 156.0.8078.4 and a scripted provider. No production-reliability claim is made.

Before release, review the PR checks, including both LibreChat revisions and all existing integration workflows. Keep the original v0.8.9 investigation evidence separate from release-candidate validation. Existing generated adapters need both the updated adapter and new `model-selection.mjs` helper; a CLI upgrade alone does not replace them.

This preparation does not include a release tag or npm publication. The published-package smoke workflow stays pinned to the existing 0.6.1 release until publication is separately authorized.

## Follow-up after 0.6.2

- Open WebUI preset: replace the one-time isVisible() submenu check with an explicit wait for the submenu/option (same class of timing risk as the LibreChat 0.6.2 fix; not reproduced; pinned CI passes). See [other-presets-audit.txt](docs/evidence/2026-11-17/other-presets-audit.txt).
