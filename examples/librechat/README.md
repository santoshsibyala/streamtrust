# LibreChat CI integration

This preset runs a **built local LibreChat checkout**, native browser UI and real disposable MongoDB. A controlled OpenAI-compatible HTTP provider supplies synthetic text. No live model key or existing database is used. Four scenarios cover saved answers, Stop, regeneration branches, and retry after a provider disconnect. This is not an official LibreChat integration.

## Installation

Use Node.js 24 and npm 11. In a separate verification project, install StreamTrust 0.2.0 from npm:

```sh
npm init -y
npm install --save-dev --save-exact streamtrust@0.2.0
npm install --save-dev --save-exact playwright@1.64.1 mongodb@6.20.0 mongodb-memory-server@11.3.0
npx playwright install chromium
npx streamtrust init streamtrust-librechat --preset librechat
```

Use Node.js 24 and npm 11 for this preset. Commit the generated adapter and your package lock. The core CLI still has no runtime dependencies; browser/database dependencies belong to the verification project. Browser, MongoDB binary and LibreChat installation require network access and disk space. The first build takes several minutes; this is not a five-minute cold installation.

## Run the supported upstream version

```sh
export STREAMTRUST_LIBRECHAT_ROOT="$PWD/.cache/librechat"
node streamtrust-librechat/setup.mjs
npx streamtrust verify --adapter streamtrust-librechat/adapter.mjs \
  --output reports/librechat --repetitions 3 --timeout-ms 600000
```

The setup script clones and builds commit `a378657583567310c841d652b0f6b00c83e2bd6b`. It refuses to reset an existing or dirty checkout. The verifier starts its own loopback-only server, chooses an available port, creates a synthetic test user, and tears down its browser, provider and disposable database. The preset refuses checkouts containing `.env`, `.env.local` or `.env.production`. Do not place production configuration in this checkout.

To test your team's committed changes, point `STREAMTRUST_LIBRECHAT_ROOT` at your **built, clean checkout** and set `STREAMTRUST_LIBRECHAT_COMMIT` to its full SHA. Skip setup if already built. This executes the actual application under test; it does not copy a test app into your repository. Compatibility with other commits is not guaranteed: changed selectors/routes/schema can cause HARNESS_ERROR rather than a product failure.

Optional settings:

| Variable | Purpose |
|---|---|
| `STREAMTRUST_LIBRECHAT_ROOT` | Required path to the built checkout |
| `STREAMTRUST_LIBRECHAT_COMMIT` | Expected full SHA; defaults to the tested upstream commit |
| `STREAMTRUST_LIBRECHAT_PORT` | Optional fixed loopback port; defaults to an ephemeral port |
| `STREAMTRUST_BROWSER_CHANNEL` | Optional installed browser channel, such as `chrome`; default is Playwright Chromium |

## CI

In your verification project, install once and commit package.json/package-lock.json and the generated preset. Add these steps to a Node 24 GitHub Actions job:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: '24'
    cache: npm
- run: npm ci
- run: npx --no-install playwright install --with-deps chromium
- name: Build isolated LibreChat checkout
  run: node streamtrust-librechat/setup.mjs
  env:
    STREAMTRUST_LIBRECHAT_ROOT: ${{ runner.temp }}/librechat
- name: Verify LibreChat
  run: npx --no-install streamtrust verify --adapter streamtrust-librechat/adapter.mjs --output reports/librechat --repetitions 3 --timeout-ms 600000
  env:
    STREAMTRUST_LIBRECHAT_ROOT: ${{ runner.temp }}/librechat
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: librechat-verification
    path: |
      reports/librechat/report.json
      reports/librechat/report.md
      reports/librechat/junit.xml
      reports/librechat/index.html
    retention-days: 7
```

Use a fresh report directory for each job. Restrict workflow permissions to `contents: read`, set a 30-minute job timeout, and use normal pull-request workflows without production secrets. To verify your fork, replace the build step with checkout/build of the intended commit and pass its SHA to the verifier.

Exit 0 means all declared checks passed; 1 means failed or unsupported checks; 2 means setup, timeout, or harness error. Keep the exit status: do not use `continue-on-error`. Inspect reports before calling a failure an upstream defect.

## Evidence and limits

`summary-only-v1` returns stable check identifiers, booleans, message counts and provider-call counts. Raw chat text, database records, user identifiers, network URLs and tokens remain in memory and are not returned as report evidence. The preset does not write screenshots, browser traces or application logs. Browser/database exceptions are replaced with fixed errors. App subprocess output is discarded. Upload only the four report files, not the entire working directory.

This is data minimization, not a universal PII detector or sandbox. Other adapters, changes to this adapter, setup/build logs and third-party processes are outside that guarantee. The core verifier still runs trusted local code. The preset deliberately does not forward application environment variables, but LibreChat can load files in its checkout: use an isolated checkout with no production configuration.

The model provider is synthetic. The test uses one server and an in-memory stream store: no Redis, real model behavior, database crash, worker kill, multi-replica or production incident-rate coverage. A single matching saved answer is not proof of exactly-once external side effects. Regeneration is a distinct sibling branch, not reuse of a request idempotency key.

The exported `streamtrust/checks` evaluator can be reused by other adapters. Map observations to `LifecycleObservation`; the evaluator validates required types, computes checks, and returns summary-only evidence. Missing or malformed observations throw, becoming HARNESS_ERROR rather than a green result.

## Validation

Local validation used macOS arm64, Node 24.22.1, Playwright 1.64.1 Chromium 156.0.8078.4, MongoDB 8.2.6, and the pinned LibreChat commit. A clean tarball consumer passed all four scenarios with three repetitions (12 executions, 99 assertions). A checkout containing an environment file was rejected with exit 2. Success and error artifact checks found only the four intended files and no tested secret/chat-text markers. The package suite has 13 tests, including negative controls for shared checks and stale-screenshot exclusion.

The [Linux GitHub Actions run](https://github.com/santoshsibyala/streamtrust/actions/runs/40451851475) also passed a cold clone/install/build, clean tarball installation, all 12 scenario executions, and upload of exactly the four report files. The verified implementation commit is `b1b2b27a19b512c6abce164502901d1716bf86a3`. Passing results do not establish an upstream defect or production reliability.
