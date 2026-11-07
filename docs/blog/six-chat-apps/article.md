# What six AI chat apps saved after Stop, Retry, and reload

I thought Open WebUI had lost my first message. I was testing it on a fresh database, and the browser timed out waiting for a reply. So I checked where my click on Send had actually gone. A release-notes popup was sitting on top of the button. My message never left the browser. I changed the test to close the popup the way a user would, ran it again, and this time the reply came through.

That was a useful way to start an investigation into streaming chat. Before I could say an app lost a message, I needed evidence that someone had actually sent it. The same problem came up in less obvious places. Before I could say Retry replaced a failed answer, for example, I needed to know what the app had saved *before* I clicked Retry.

On November 6, I exercised six open-source chat apps or examples at pinned revisions. I used StreamTrust to organize repeated checks, Playwright to drive a real browser, and synthetic responses whose text and timing I controlled. I wanted to learn which observations I could carry from one app to the next, and where I needed a different test.

## Four questions to ask a chat app

For **persistence**, I let a reply finish, read the conversation from storage, and reloaded the page. A browser can render the right answer from memory while the database holds an earlier chunk. There’s another way to get a misleading pass here. If the app generates the same answer again on reload, a deterministic provider can return a perfect text match. Where the adapter can count generation requests across the reload, that tells the two cases apart.

For **Stop**, I waited until the first text appeared while the stream was still open. That gave me a specific moment to look for the control and try it. I could then watch for late text, inspect the saved partial answer, or observe the provider connection closing. Each observation answers a different question. A user can see the text stop moving without knowing whether the server is still working.

For **regeneration**, I gave successive answers distinguishable text and inspected what happened to the first one. For **error retry**, I introduced a provider failure before asking the app to recover. The order matters. If an error has to survive a page reload, the test has to reload *before* clicking Retry. Reloading after a successful recovery only tells me where the new answer ended up.

## What counted as storage

I opened fresh browser contexts and followed each app’s own path back to a conversation. For LibreChat I queried disposable MongoDB. For Vercel Chatbot and LobeHub I compared browser observations with PostgreSQL. NextChat kept the active session in the browser, so I read its persisted IndexedDB record. For Open WebUI I used the authenticated saved-chat API that reads the app’s database. The stock assistant-ui example had no durable history adapter to inspect.

I also had to decide where to control the stream. Holding a local provider connection open let me check a control while the reply was in progress. LobeHub’s fixture worked at the browser transport instead. That was enough to exercise its interface, but the observation ended at the browser. Across apps, I recorded which layer supplied the evidence before interpreting a green result.

## What happened in each app

Each fraction describes repetitions of the check named in that row. Only LibreChat ran the shared evaluator in this investigation.

| App and pinned revision | Result |
| --- | --- |
| Vercel Chatbot · `a8989b52` | Persistence passed 5/5. Stop was unavailable mid-stream 5/5. Edit-and-resend passed 5/5 after completion and 5/5 after a provider error. |
| LibreChat · `f4154b64` | All four shared checks passed, 20/20. These included provider abort on Stop, preserved regeneration branches, and an error visible after reload before Retry. |
| NextChat · `1d3dc331` | All four app-specific checks passed, 20/20. Retry left one replacement answer in the active session. The investigation read the final saved state. |
| Open WebUI · `c38885a1` | After dialog dismissal, all four browser and saved-chat API checks passed, 20/20. The audit checked for saved siblings on regeneration but did not assert which sibling ID reload selected. |
| assistant-ui · `d9c70b32` | In the AI SDK v7 example, Stop, regeneration and retry each passed 5/5 at the UI. Persistence was unsupported in all five attempts. |
| LobeHub · `ee06a9dc` | Persistence, held-stream Stop and regeneration each passed 5/5. Recovery after an HTTP 401 passed 5/5. Recovery from a mid-stream error remained inconclusive. |

I screened a seventh candidate, Chatbot UI, and skipped it. At the time of the audit its last push was in August 2024, and I couldn’t establish current maintenance or acceptance of outside contributions. It contributed no runs to the table.

The disappearing Vercel Chatbot control was the only confirmed product defect in these runs. A standalone Playwright script held the stream open and reproduced the missing button in five of five attempts without StreamTrust. Earlier contributors had already proposed changing this behavior. My contribution was the newer-revision reproduction, the recording, and a script a maintainer can run independently. [Issue and reproduction](https://github.com/vercel/chatbot/issues/1565) · [Earlier PR #877](https://github.com/vercel/chatbot/pull/877) · [Earlier PR #902](https://github.com/vercel/chatbot/pull/902)

## The test I had to change

LibreChat gives regeneration a concrete meaning. The replacement gets a distinct message ID and shares a parent with the original. I can read both saved answers and then reload to see which one the user gets. NextChat intentionally replaces the previous turn in the active session. Requiring it to preserve a sibling would turn a design choice into a failing test.

My first NextChat adapter made the opposite mistake. It let the first response finish, clicked Retry, then checked for one saved assistant answer containing the second response after reload. It counted two provider calls. All of that could be true even if the first answer had *never been saved*. I had verified the final state. I had given the check a name broad enough to suggest I’d verified the transition.

When I packaged the preset, I added a read of the active session immediately before Retry. The report now calls the check `regeneration.replace-turn`. It requires the completed original to be saved first, then checks that its ID is absent and the replacement survives reload. Its companion, `error-retry.replace-turn-same-session`, observes the saved partial before Retry. The name tells a reader exactly when recovery happens. Whether the error itself survives a reload before Retry is a separate question. [NextChat preset and contracts](https://github.com/santoshsibyala/streamtrust/blob/v0.5.0/examples/nextchat/README.md)

The Open WebUI preset also goes further than the original audit. It checks the original sibling’s content and ID and which replacement is active after reload. On Stop, it observes the mock response close before completion and reads the saved partial. Those assertions belong to the released preset. Applying them retroactively to the investigation would give the original runs credit for observations I never made. [Open WebUI preset and contracts](https://github.com/santoshsibyala/streamtrust/blob/v0.5.0/examples/open-webui/README.md)

## Where the evidence ended

LobeHub exposed the limits of counting requests. Its automatic retries also contributed to the count after an injected stream error. I couldn’t establish that a durable error existed before the manual retry, so the count couldn’t tell me whether a user action had duplicated a turn. A separate terminal HTTP rejection gave me an observable starting point. I found the assistant error in PostgreSQL, restored the transport, used the native regeneration menu and saw the replacement after reload. That answers the rejected-request question. The interrupted-stream question stays open.

These were local experiments at one revision per app. Repeating them tells me whether I can reproduce the observation under those conditions. It gives me no estimate of how often someone hits it in production. Likewise, only the checks instrumented to see a provider abort can support a transport claim. Even there, the endpoint was a controlled provider. I didn’t measure cancellation inside a hosted model service.

## Try one check yourself

With Node.js 22 or newer, run the HTTP streaming example in a scratch npm project. It starts with a bundled demo so you can inspect a report before connecting your own application.

```sh
npm install --save-dev --save-exact streamtrust@0.5.0
npx streamtrust init
npx streamtrust verify --adapter ./streamtrust/adapter.mjs
```

The available presets are `http`, `librechat`, `vercel-ai`, `nextchat` and `open-webui`. Use `npx streamtrust init <directory> --preset <preset>` to select one. NextChat and Open WebUI also accept the short form, for example `npx streamtrust init nextchat`. Follow the preset’s setup steps for its browser, runtime and test services. The Vercel AI SDK preset runs a minimal reference app. The Vercel Chatbot reproduction is in the upstream issue. [StreamTrust and setup guides](https://github.com/santoshsibyala/streamtrust)

Once your workflow checks out your adapter and prepares its dependencies and services, add this step. It writes the outcomes to the job summary and uploads the reports. [StreamTrust CI Verifier](https://github.com/marketplace/actions/streamtrust-ci-verifier)

```yaml
- uses: santoshsibyala/streamtrust-action@v1
  with:
    adapter: ./streamtrust/adapter.mjs
    node-version: '22'
```

If you want to try one of these checks on your own app, start with Retry. Let the first answer finish, look at what got saved, then hit Retry and reload the page. Can you still get back to the first answer, or did the second one replace it? Either one can be fine. What matters is checking what’s saved *before* you click. That was the step my NextChat test was missing.
