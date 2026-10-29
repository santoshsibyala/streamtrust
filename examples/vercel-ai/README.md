# Vercel AI SDK CI integration

This preset runs a **minimal Next.js chat built on the AI SDK** (`ai`, `@ai-sdk/react` `useChat`, `streamText`) in production mode, drives its UI with Playwright, and compares what the browser showed with what the app saved. A synthetic OpenAI-compatible HTTP provider supplies deterministic text, so no model key is needed. Four scenarios cover saved answers, Stop, regeneration branches, and retry after a provider failure. This is not an official Vercel integration and is not endorsed by Vercel.

## Quick start (no API key)

Use Node.js 22 or newer (AI SDK 7 requires it). This preset is available in StreamTrust 0.3.0. In a separate verification project:

```sh
npm init -y
npm install --save-dev --save-exact streamtrust@0.3.0 playwright@1.64.1
npx playwright install chromium
npx streamtrust init streamtrust-vercel-ai --preset vercel-ai
node streamtrust-vercel-ai/setup.mjs
npx streamtrust verify --adapter streamtrust-vercel-ai/adapter.mjs \
  --output reports/vercel-ai --repetitions 3
```

`setup.mjs` installs and builds `streamtrust-vercel-ai/reference-app` (Next.js 16, AI SDK 7, pinned exact versions). The bundled `npm-shrinkwrap.json` pins transitive dependencies and setup uses `npm ci`. Commit the generated preset including this lockfile, and ignore `reference-app/node_modules/` and `reference-app/.next/`. Build and verification time depend on the machine. A cold install needs network access for npm and the Chromium download.

The verifier starts the built app on a loopback-only ephemeral port with a fresh temporary chat store, starts the provider and a headless browser, and tears all of them down afterwards. It does not forward your environment to the app (only `PATH`, `HOME` and temp-directory variables), and refuses an app directory containing `.env`, `.env.local`, `.env.production` or `.env.production.local`, because Next.js would load those files.

## What each scenario checks

The adapter maps observations onto the shared `streamtrust/checks` lifecycle evaluator:

| Scenario | Action | Key assertions |
|---|---|---|
| `persistence` | Send, let the provider finish | Exactly one saved answer equals the streamed text; it survives reload; reload does not call the model again |
| `cancellation` | Click Stop after the first chunk | The provider connection is aborted before completion; the partial answer is saved as unfinished; a late completion cannot be delivered |
| `regeneration` | Finish, then click Regenerate | The new answer is saved as a sibling of the original (same parent, distinct id); the original is kept; only the new answer is shown after reload |
| `error-retry` | Provider drops mid-stream, reload, Regenerate | The failure is saved and still visible after reload; the retry is saved as a complete answer; the failed partial is no longer shown |

The reference app is a fixture for validating the verifier, not evidence of an upstream defect. Negative controls and their observed results are recorded in the release notes.

Two semantics are specific to the AI SDK and worth knowing:

- **Stop is a client-side fetch abort.** There is no server stop endpoint, so `cancel.server-acknowledged` means "the server persisted the aborted state", observed in the store, not a response to a stop request.
- **Regeneration is checked as branching.** The reference app keeps the old answer as a sibling. Many AI SDK apps instead save the client's `messages` array in `onFinish`, which drops the old answer on regenerate. Against such an app the regeneration branch checks fail by design. If replacing history is your intended behavior, return `{ checks: [], evidence: {}, unsupported: 'Regenerate replaces history' }` for that scenario instead of weakening the check.

## Verify your own AI SDK app

The reference app is a demonstration: **its passing says nothing about your application.** To test your app, point the adapter at a built checkout:

```sh
export STREAMTRUST_VERCEL_AI_ROOT=/path/to/your/next-app
# Build your isolated checkout using its usual build command.
npx streamtrust verify --adapter streamtrust-vercel-ai/adapter.mjs --output reports/vercel-ai
```

Then edit `adapter.mjs` where your app differs. Expect HARNESS_ERROR, not FAIL, until the mapping matches:

1. **Provider wiring.** The adapter passes `MODEL_BASE_URL`, `MODEL_API_KEY` and `MODEL_NAME` to the app. Your route must create its model from those, for example `createOpenAICompatible({ name, baseURL: process.env.MODEL_BASE_URL, apiKey: process.env.MODEL_API_KEY })`, at least in test builds. Without this the app calls a real provider or fails to start.
2. **Authoritative read.** `saved(id)` reads the reference app's JSON store from `CHAT_STORE_DIR`. Replace it with a read of your database, mapping each assistant message to `{ id, parentId, text, status }` where status is `complete`, `streaming`, `aborted` or `error`.
3. **UI selectors.** The adapter types into the textbox named `Message` and presses Enter, then uses the buttons named `Stop` and `Regenerate`, the `data-testid="messages"` container, the URL `/chat/<id>`, and the failure text `The model provider failed.`. Change them to match your UI.
4. **Other services.** Start any database, auth or migrations your app needs in the adapter factory, and register their cleanup.

Optional settings:

| Variable | Purpose |
|---|---|
| `STREAMTRUST_VERCEL_AI_ROOT` | Built app directory; defaults to the bundled `reference-app` |
| `STREAMTRUST_VERCEL_AI_PORT` | Fixed loopback port; defaults to an ephemeral port |
| `STREAMTRUST_BROWSER_CHANNEL` | Installed browser channel such as `chrome`; defaults to Playwright Chromium |
| `STREAMTRUST_VERCEL_AI_DEBUG` | `1` prints raw adapter errors and app stderr to the console (never into reports) |

## CI

Run the installation steps once, then commit your verification project package.json, lockfile, and generated preset. Use a job with `permissions: { contents: read }`, `timeout-minutes: 20`, and no production secrets. These steps run the bundled reference app; adapt the adapter and build step to verify your own application.

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: '22'
    cache: npm
- run: npm ci
- run: npx --no-install playwright install --with-deps chromium
- run: node streamtrust-vercel-ai/setup.mjs
- name: Verify AI SDK app
  run: npx --no-install streamtrust verify --adapter streamtrust-vercel-ai/adapter.mjs --output reports/vercel-ai --repetitions 3
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: vercel-ai-verification
    path: |
      reports/vercel-ai/report.json
      reports/vercel-ai/report.md
      reports/vercel-ai/junit.xml
      reports/vercel-ai/index.html
    retention-days: 7
```

Exit 0 means all declared checks passed; 1 means failed or unsupported checks; 2 means setup, timeout or harness error. Keep the exit status: do not use `continue-on-error`.

## Evidence and limits

Reports use `summary-only-v1`: stable check names, booleans, message counts and provider-call counts. Chat text, message ids, URLs and file paths stay in memory. Reports replace browser and app exceptions with fixed messages even in debug mode. Debug mode prints raw errors to the console; do not enable it in CI that retains logs. This is data minimization, not a sandbox: the adapter and the app under test are trusted code.

What this does **not** verify: real model behavior or output quality, multiple server instances, resumable streams (`resume: true`), server crashes or redeploys mid-stream, tool calls, the AI SDK's own correctness in general, or production reliability. The model is synthetic, and the reference app's file store is a stand-in for a database. The fixture has no authentication or concurrency control and must not be deployed as a production chat app. A single matching saved answer is not proof of exactly-once side effects.

## Release validation

For 0.3.0, a clean tarball consumer on macOS with Node 22.22.3 and Chromium 156.0.8078.4 passed all four scenarios with three repetitions (12 executions, 99 assertions). The 17 package tests passed on Node 22 and 24. The locked fixture dependencies reported no known vulnerabilities in `npm audit` at review time.

Three isolated mutations were each detected as FAIL with exit 1: removing request-abort propagation (`cancel.provider-aborted`), deleting the original regeneration branch (`retry.original-branch-preserved`), and skipping persistence for failed outcomes (`error.saved-before-retry`). These are deliberately broken copies of our fixture, not bugs attributed to Vercel or another team's app. Run `node test/vercel-ai-controls.mjs /path/to/consumer preset-directory` from the source repository to reproduce them against a disposable generated preset; the script restores the route and rebuilds afterwards.

The GitHub integration workflow runs the baseline and negative controls on Linux. See its actual run status before relying on Linux validation. Successful report checks found none of the tested synthetic text, local-path, or key markers; this is not a guarantee against arbitrary sensitive data in customized adapters.
