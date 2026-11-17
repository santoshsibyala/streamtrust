# Changelog

## 0.6.2 (unreleased)

- Fixed: LibreChat model selection accepts the accessible “selected” suffix and waits for the fixture model label before submitting. This prevents intermittent pre-submit harness errors on v0.8.9 without changing lifecycle assertions.
- Added: browser regression coverage for selected/unselected options, delayed readiness, and a model that never becomes ready. The LibreChat workflow tests the helper from the packed, generated preset.
- Existing generated adapters are not updated by upgrading the CLI alone. Generate the LibreChat preset in a new directory and merge both `adapter.mjs` and the new `model-selection.mjs` into customized adapters.

## 0.6.1

- Fixed: generated browser adapters now declare Playwright and give a folder-specific install command when it is missing. LibreChat also declares its MongoDB dependencies.

## 0.6.0

### Breaking changes

Generated adapters use the following scenario names in reports. Update any CI filters or comparisons that use the old names.

| Preset | 0.5.0 name | 0.6.0 name |
| --- | --- | --- |
| http | `persistence` | `persistence.http-sse` |
| http | `cancellation` | `cancellation.http-sse` |
| http | `retry` | `retry.http-sse` |
| nextchat | `persistence` | `persistence.saved-turn` |
| nextchat | `cancellation` | `cancellation.saved-partial` |
| open-webui | `persistence.shared` | `persistence` |
| open-webui | `regeneration.shared-active-sibling` | `regeneration` |
| open-webui | `error-retry.shared-saved-visible` | `error-retry` |

No scenario names changed in librechat or vercel-ai. Open WebUI retains its active-selection checks.

To refresh an existing adapter, run `npx streamtrust@0.6.0 init fresh-adapter --preset <preset>` in a new directory and merge the generated files into your customized copy.

**Optional revision overrides for your own CI.** Omit these settings to keep the reproducible defaults.

- NextChat: set `STREAMTRUST_NEXTCHAT_REF` to a full lowercase commit SHA, or to `current` to test HEAD in the clean checkout at `STREAMTRUST_NEXTCHAT_ROOT`.
- LibreChat: set `STREAMTRUST_LIBRECHAT_COMMIT=current` to test the existing clean checkout, or supply an expected full lowercase commit SHA.
- Open WebUI: set `STREAMTRUST_OPEN_WEBUI_IMAGE` to a local image ID or a pulled repository digest, and `STREAMTRUST_OPEN_WEBUI_REF` to its expected full lowercase commit SHA. Alternatively, set the ref to `current` and point `STREAMTRUST_OPEN_WEBUI_ROOT` at the checkout. The image’s OCI revision label must match.

## 0.5.0

- Add the Open WebUI preset, a pinned upstream Docker image, named lifecycle contracts and a packed-CLI integration workflow.

## 0.4.0

- Added `streamtrust init nextchat` and `--preset nextchat`. A local provider and Playwright exercise a separate MIT-licensed NextChat checkout at `1d3dc331512929a4b1d3e82354e72acce33b5c7a`.
- Four scenarios check persistence across reload, stopping a partial reply, regenerating an answer and retrying after a provider disconnect. The adapter reads NextChat's browser-local saved history.
- Added the NextChat setup and CI guide, a packed-package integration workflow, and npm discovery keywords.
