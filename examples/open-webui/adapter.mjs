import { chromium } from "playwright";
import { evaluateLifecycle } from "streamtrust/checks";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { startProvider, until } from "./provider.mjs";

const image =
  "ghcr.io/open-webui/open-webui@sha256:283efb20756785229a388bcd1e56a052f5284ae8c861717eed5eaaa3bba6b20a";
const revision = "c38885a1a737da4968f157092f304f3b5481d0bf";
const scenarios = [
  "persistence.shared",
  "cancellation.provider-abort-saved-partial",
  "regeneration.shared-active-sibling",
  "error-retry.shared-saved-visible",
];
const docker = (args, env = {}) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }).trim();

// The API gives current_message_id precedence over history.currentId on hydration.
async function saved(page) {
  return page.evaluate(async () => {
    const id = location.pathname.split("/").pop();
    const response = await fetch("/api/v1/chats/" + id, {
      headers: { authorization: "Bearer " + localStorage.token },
    });
    if (!response.ok) throw Error("Saved-chat API unavailable");
    const chat = await response.json();
    const history = chat.chat.history;
    return {
      active: chat.current_message_id || history.currentId,
      answers: Object.values(history.messages).filter(
        (m) => m.role === "assistant",
      ),
    };
  });
}

export default async function create() {
  const name = "streamtrust-webui-" + randomUUID();
  const key = randomUUID(),
    password = randomUUID(),
    email = randomUUID() + "@example.com";
  let browser,
    provider,
    started = false;
  const close = async () => {
    try {
      await browser?.close();
    } finally {
      try {
        if (started) docker(["rm", "-fv", name]);
      } finally {
        await provider?.close();
      }
    }
  };
  try {
    // Linux containers reach the host on the default bridge gateway. Docker Desktop
    // provides host.docker.internal for services listening on the host loopback.
    const linux = process.platform === "linux";
    const gateway = linux
      ? docker([
          "network",
          "inspect",
          "bridge",
          "--format",
          "{{(index .IPAM.Config 0).Gateway}}",
        ])
      : "127.0.0.1";
    provider = await startProvider(gateway, key);
    const settings = {
      WEBUI_ADMIN_EMAIL: email,
      WEBUI_ADMIN_PASSWORD: password,
      WEBUI_SECRET_KEY: randomUUID(),
      ENABLE_SIGNUP: "False",
      OFFLINE_MODE: "True",
      ENABLE_OLLAMA_API: "False",
      ENABLE_OPENAI_API: "True",
      OPENAI_API_BASE_URL: `http://${
        linux ? gateway : "host.docker.internal"
      }:${provider.port}/v1`,
      OPENAI_API_KEY: key,
      DEFAULT_MODELS: "gpt-4o-mini",
      ENABLE_TITLE_GENERATION: "False",
      ENABLE_TAGS_GENERATION: "False",
      ENABLE_FOLLOW_UP_GENERATION: "False",
      ENABLE_VERSION_UPDATE_CHECK: "False",
      ENABLE_PERSISTENT_CONFIG: "False",
      HF_HUB_OFFLINE: "1",
      RAG_EMBEDDING_MODEL_AUTO_UPDATE: "False",
      RAG_RERANKING_MODEL_AUTO_UPDATE: "False",
    };
    docker(
      [
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-p",
        "127.0.0.1::8080",
        "--tmpfs",
        "/app/backend/data",
        ...Object.keys(settings).flatMap((k) => ["-e", k]),
        image,
      ],
      settings,
    );
    started = true;
    const url = "http://" + docker(["port", name, "8080/tcp"]);
    await until(
      async () => {
        try {
          return (await fetch(url + "/health")).ok;
        } catch {
          return false;
        }
      },
      "container health",
      180000,
    );
    const login = await fetch(url + "/api/v1/auths/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!login.ok) throw Error("Disposable admin sign-in failed");
    const { token } = await login.json();
    if (!token) throw Error("Disposable admin session unavailable");
    browser = await chromium.launch({
      channel: process.env.STREAMTRUST_BROWSER_CHANNEL,
    });
    return {
      name: "Open WebUI",
      scenarios,
      close,
      metadata: async () => ({
        commit: revision,
        image,
        evidencePolicy: "summary-only-v1",
      }),
      async run(label) {
        const scenario = label.split(".")[0];
        const ctx = await browser.newContext({
          locale: "en-US",
          storageState: {
            cookies: [],
            origins: [
              { origin: url, localStorage: [{ name: "token", value: token }] },
            ],
          },
        });
        let stage = "opening the local chat";
        const start = provider.calls.length;
        const calls = () => provider.calls.slice(start).filter((c) => c.send);
        const check = (name, passed) => ({ name, passed });
        try {
          await ctx.route(/^https?:\/\//, (r) =>
            new URL(r.request().url()).origin === url
              ? r.continue()
              : r.abort(),
          );
          const page = await ctx.newPage();
          const text = () => page.locator("body").innerText();
          const has = async (value) => (await text()).includes(value);
          const untilVisible = (value) =>
            until(() => has(value), "rendered answer");
          const stop = page.getByRole("button", { name: "Stop", exact: true });
          const dialog = page.getByRole("dialog", { name: /What.s New/i });
          await page.addLocatorHandler(dialog, () =>
            dialog.getByRole("button", { name: "Close", exact: true }).click(),
          );
          await page.goto(url);
          await page
            .getByText("gpt-4o-mini", { exact: true })
            .first()
            .waitFor();
          await page.locator("#chat-input").fill("Synthetic lifecycle check");
          await page
            .getByRole("button", { name: "Send message", exact: true })
            .click();
          stage = "waiting for first provider call";
          await until(() => calls().length === 1, "first generation");
          const first = calls()[0];
          first.send(first.prefix);
          await untilVisible(first.prefix);
          await page.waitForURL("**/c/*");
          let target = first,
            aborted = false,
            failure,
            originalId;
          stage = "settling the first response";
          if (scenario === "cancellation") {
            await stop.click();
            await stop.waitFor({ state: "hidden" });
            // A closed response counts only while the provider is still holding it open.
            const deadline = Date.now() + 5000;
            while (!first.closed && Date.now() < deadline)
              await new Promise((r) => setTimeout(r, 50));
            aborted = first.closed && !first.sentFinish;
            if (!first.closed) first.finish();
          } else if (scenario === "error-retry") {
            first.error();
            await stop.waitFor({ state: "hidden" });
            const stateBeforeRetry = await saved(page);
            const failed = stateBeforeRetry.answers.find(
              (m) =>
                m.id === stateBeforeRetry.active &&
                m.content?.includes(first.prefix) &&
                JSON.stringify(m.error ?? "").includes(
                  "Synthetic test interruption",
                ),
            );
            await page.reload();
            await untilVisible(first.prefix);
            await page
              .getByText("Synthetic test interruption", { exact: false })
              .last()
              .waitFor({ timeout: 5000 })
              .catch(() => {});
            failure = {
              saved: !!failed,
              visibleAfterReload: await has("Synthetic test interruption"),
            };
            if (!failure.saved || !failure.visibleAfterReload)
              return {
                checks: [],
                unsupported:
                  "Saved provider error and its visible marker could not both be established across reload before retry.",
                evidence: failure,
              };
          } else {
            first.finish();
            await untilVisible(first.prefix + first.suffix);
          }
          if (scenario === "regeneration" || scenario === "error-retry") {
            stage = "observing the original and regenerating";
            if (scenario === "regeneration") {
              await until(async () => {
                const state = await saved(page);
                originalId = state.answers.find(
                  (m) => m.content === first.prefix + first.suffix,
                )?.id;
                return originalId && state.active === originalId;
              }, "saved original");
            }
            await page
              .getByRole("button", { name: "Regenerate", exact: true })
              .last()
              .click();
            const menu = page
              .getByRole("menuitem", { name: /regenerate|try again/i })
              .first();
            if (await menu.isVisible()) await menu.click();
            await until(() => calls().length === 2, "second generation");
            target = calls()[1];
            target.send(target.prefix);
            target.finish();
          }
          stage = "checking saved state and reload";
          const expected =
            scenario === "cancellation"
              ? target.prefix
              : target.prefix + target.suffix;
          await untilVisible(expected);
          await until(
            async () =>
              (await saved(page)).answers.some((m) => m.content === expected),
            "saved reply",
          );
          const beforeReload = await text(),
            callsBeforeReload = calls().length;
          await page.reload();
          await untilVisible(target.prefix);
          const reloaded = await text(),
            state = await saved(page);
          const active = state.answers.find((m) => m.id === state.active);
          const activeMatches = active?.content === expected;
          let checks;
          if (scenario === "cancellation") {
            checks = [
              check("Provider observed abort before finish", aborted),
              check(
                "Active partial saved and visible after reload",
                activeMatches && reloaded.includes(expected),
              ),
              check("Late suffix absent", !reloaded.includes(first.suffix)),
              check(
                "Exactly one generation across reload",
                calls().length === 1,
              ),
            ];
          } else {
            if (state.answers.some((m) => typeof m.done !== "boolean"))
              return {
                checks: [],
                unsupported:
                  "Saved assistant completion state unavailable for shared checks.",
                evidence: {},
              };
            ({ checks } = evaluateLifecycle({
              scenario,
              expected,
              original: first.prefix + first.suffix,
              previousPrefix: first.prefix,
              beforeReload,
              reloaded,
              callsBeforeReload,
              callsAfterReload: calls().length,
              failure,
              messages: state.answers.map((m) => ({
                id: m.id,
                parentId: m.parentId,
                text: m.content,
                assistant: true,
                unfinished: !m.done,
                error: !!m.error,
              })),
            }));
            checks.push(
              check("Saved active ID selects expected answer", activeMatches),
            );
            if (scenario === "regeneration")
              checks.push(
                check(
                  "Original ID and content retained",
                  state.answers.some(
                    (m) =>
                      m.id === originalId &&
                      m.content === first.prefix + first.suffix,
                  ),
                ),
              );
          }
          return {
            checks,
            evidence: {
              callsBeforeReload,
              callsAfterReload: calls().length,
              assistantCount: state.answers.length,
              activeMatches,
            },
          };
        } catch {
          throw Error("Open WebUI observation failed while " + stage);
        } finally {
          for (const c of calls()) if (!c.closed) c.res.end();
          await ctx.close();
        }
      },
    };
  } catch {
    await close();
    throw Error(
      "Open WebUI setup failed. Check Docker, the pinned image, local provider routing, admin bootstrap and Chromium.",
    );
  }
}
