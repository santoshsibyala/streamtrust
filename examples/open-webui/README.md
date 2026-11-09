# Open WebUI integration

The adapter drives a disposable Open WebUI v0.13.0 instance with Playwright and a local OpenAI-compatible provider. The upstream commit is `c38885a1a737da4968f157092f304f3b5481d0bf`. The official slim image index is pinned to `ghcr.io/open-webui/open-webui@sha256:283efb20756785229a388bcd1e56a052f5284ae8c861717eed5eaaa3bba6b20a` for amd64 and arm64.

## Setup

Install Node 22+, Docker and Playwright. Start Docker before running the verifier. From a verification project, once the CLI release is available:

```sh
npm install --save-dev --save-exact streamtrust@0.6.0 playwright@1.64.1
npx playwright install chromium
npx streamtrust init open-webui
npx streamtrust verify --adapter open-webui/adapter.mjs --output reports/open-webui --repetitions 3 --timeout-ms 900000
```

Use `init <directory> --preset open-webui` to choose a directory. The adapter publishes the app on a randomly assigned loopback port, waits for health, signs into a runtime-generated admin account, and dismisses the first-launch release dialog. Each scenario uses a fresh browser context and a new chat. The container data directory lives in tmpfs and is removed on cleanup. The app connects to a mock on the Docker bridge gateway on native Linux or through Docker Desktop host routing on macOS. The provider requires a disposable bearer key.

## Saved state and contracts

The adapter reads the authenticated saved-chat API (`GET /api/v1/chats/{id}`) backed by Open WebUI’s local database. The history contains the assistant records and parent IDs. Reload selects the persisted `current_message_id`, falling back to `chat.history.currentId` when the former is absent. The adapter compares the selected record and visible reply after reload.

| Report scenario | What a pass requires |
|---|---|
| `persistence` | Shared evaluator: one matching complete, error-free answer, visible before and after reload, with no new generation on reload. The active saved record must match. |
| `cancellation.provider-abort-saved-partial` | App-specific: after native Stop, the mock sees its open HTTP response close before completion. The partial answer stays active and saved after reload, no late suffix appears, and generation count stays at one. Open WebUI can mark a stopped message done. |
| `regeneration` | Shared evaluator plus active selection: the completed original is saved before Regenerate. The original content and ID survive, the replacement has a distinct ID and the same parent, and reload selects the replacement. |
| `error-retry` | Shared evaluator plus active selection: a synthetic SSE provider error is saved and visible after reload before Regenerate. The replacement is active in storage and visible after a second reload. |

An unavailable required storage field produces UNSUPPORTED where the adapter cannot establish the contract. Runtime or selector errors produce harness errors. Shareable evidence includes booleans and counts. Only the synthetic text-error fixture and the pinned app’s single-user chat lifecycle are in scope.

## Running in your own CI

With no overrides the preset uses the published digest and revision above. To test your CI checkout, first build its upstream image using your normal build process. Label the image with `--label "org.opencontainers.image.revision=$(git rev-parse HEAD)"` and export its immutable image ID, for example:

```sh
echo "STREAMTRUST_OPEN_WEBUI_IMAGE=$(docker image inspect --format '{{.Id}}' open-webui:ci)" >> "$GITHUB_ENV"
```

Set `STREAMTRUST_OPEN_WEBUI_REF` to the full lowercase checkout SHA on the verification step, or use `current` with `STREAMTRUST_OPEN_WEBUI_ROOT` pointing to the checkout (defaults to the working directory). A custom image must already exist on the runner as a local image ID or a pulled repository digest. The adapter compares its OCI revision label with the expected SHA before launch and records the selected image and revision. Build the image from clean source: the label is build metadata supplied by your build.

```yaml
  env:
    STREAMTRUST_OPEN_WEBUI_REF: ${{ github.sha }}
```


## Run in CI

Commit the generated adapter and consumer lockfile. On an Ubuntu Docker runner, after checkout, Node setup, `npm ci` and `npx playwright install --with-deps chromium`, use the [StreamTrust Action](https://github.com/santoshsibyala/streamtrust-action):

```yaml
- uses: santoshsibyala/streamtrust-action@v1
  with:
    version: '0.6.0'
    adapter: open-webui/adapter.mjs
    repetitions: '3'
    timeout-ms: '900000'
    artifact-name: open-webui-safe-reports
    fail-on: failures
```

## Upstream license

Open WebUI runs from a separate upstream image under the [Open WebUI License](https://github.com/open-webui/open-webui/blob/c38885a1a737da4968f157092f304f3b5481d0bf/LICENSE). It imposes branding, notice and endorsement conditions. This independent preset preserves the upstream interface and branding and ships only verification code.
