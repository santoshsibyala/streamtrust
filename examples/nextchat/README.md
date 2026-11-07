# NextChat CI integration

This preset drives a separate [NextChat checkout](https://github.com/ChatGPTNextWeb/NextChat/tree/1d3dc331512929a4b1d3e82354e72acce33b5c7a) with Playwright and a loopback OpenAI-compatible provider. NextChat is MIT licensed. Its source and dependencies stay in the checkout.

## Setup

In a verification project with Node 22 (the install command selects Yarn Classic 1.22.22):

```sh
npm init -y
npm install --save-dev --save-exact streamtrust@0.4.0 playwright@1.64.1
npx playwright install chromium
npx streamtrust init nextchat
export STREAMTRUST_NEXTCHAT_ROOT="$PWD/.cache/NextChat"
git clone https://github.com/ChatGPTNextWeb/NextChat.git "$STREAMTRUST_NEXTCHAT_ROOT"
git -C "$STREAMTRUST_NEXTCHAT_ROOT" checkout --detach 1d3dc331512929a4b1d3e82354e72acce33b5c7a
(cd "$STREAMTRUST_NEXTCHAT_ROOT" && npx --yes --package=yarn@1.22.22 -- yarn install --frozen-lockfile --ignore-scripts)
npx streamtrust verify --adapter nextchat/adapter.mjs --output reports/nextchat --repetitions 3 --timeout-ms 900000
```

Use a dedicated checkout with clean tracked files and no development dotenv files. The adapter starts NextChat in development mode on loopback, waits for HTTP readiness, and closes the app, provider and browser after verification. Requests use a synthetic key. Each repetition starts in a fresh browser context. To choose another output directory for the template, use `streamtrust init <directory> --preset nextchat`. To use installed Chrome, set `STREAMTRUST_BROWSER_CHANNEL=chrome`.

## What it checks

| Scenario | Expected outcome after reload |
|---|---|
| Persistence | One assistant answer matches the complete provider response, with one generation. |
| Cancellation | Clicking Stop after the first chunk preserves only the partial answer. Late completion text stays absent even if the provider can finish. |
| `regeneration.replace-turn` | Before Retry, the completed first answer is saved. After reload, the original assistant ID is absent and the sole assistant answer matches the second response. |
| `error-retry.replace-turn-same-session` | After a mid-stream disconnect, the first partial answer is saved before Retry. The replacement survives reload and the original assistant ID is absent. |

NextChat intentionally replaces the previous turn on Retry, so these NextChat-specific checks verify replacement in the active session; the shared evaluator checks branch preservation on regeneration and a saved error visible after reload before retry.

The adapter reads the selected session in the persisted Zustand record `chat-next-web-store` (IndexedDB database `keyval-store`, object store `keyval`; NextChat also supports localStorage fallback). It compares assistant text from storage with the rendered page and counts streaming provider calls. This tests browser-local persistence in one session. The Stop check covers visible and saved output. It does not establish server-side cancellation. The retry check covers recovery in the same session, without requiring a durable error flag or sibling branches. The pre-Retry read checks partial text for error retry. Whether a failure flag survives a reload before Retry is outside this scenario. Per-run evidence contains only booleans. Message text and IDs stay in memory. A changed selector or unreadable storage can produce a harness error.

## Run in CI

After installing the locked consumer dependencies, installing Chromium, and preparing the pinned checkout above, export `STREAMTRUST_NEXTCHAT_ROOT` for the job. Commit the generated adapter and helper. With CLI 0.4.0 published, use the [StreamTrust Action](https://github.com/santoshsibyala/streamtrust-action):

```yaml
- name: Verify NextChat
  uses: santoshsibyala/streamtrust-action@v1
  with:
    adapter: nextchat/adapter.mjs
    version: '0.4.0'
    node-version: '22'
    repetitions: '3'
    timeout-ms: '900000'
    artifact-name: nextchat-safe-reports
    fail-on: failures
```
