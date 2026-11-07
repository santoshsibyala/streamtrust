import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { startProvider, until } from "./provider.mjs";
const commit = "1d3dc331512929a4b1d3e82354e72acce33b5c7a";

async function availablePort() {
  const socket = createServer();
  await new Promise((ready, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", ready);
  });
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  return port;
}

async function create() {
  if (!process.env.STREAMTRUST_NEXTCHAT_ROOT)
    throw Error(
      "Set STREAMTRUST_NEXTCHAT_ROOT to the isolated NextChat checkout",
    );
  const root = resolve(process.env.STREAMTRUST_NEXTCHAT_ROOT);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (
    git("rev-parse", "HEAD") !== commit ||
    git("status", "--porcelain", "--untracked-files=no")
  )
    throw Error("Expected clean pinned NextChat source");
  for (const file of [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
  ]) {
    if (existsSync(resolve(root, file)))
      throw Error("Remove dotenv files from the isolated checkout");
  }
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const provider = await startProvider();
  const app = spawn(
    process.execPath,
    [
      resolve(root, "node_modules/next/dist/bin/next"),
      "dev",
      "-H",
      "127.0.0.1",
      "-p",
      String(port),
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NEXT_TELEMETRY_DISABLED: "1",
        BASE_URL: provider.url,
        OPENAI_API_KEY: "local-synthetic-only",
        DEFAULT_MODEL: "gpt-4o-mini",
        CUSTOM_MODELS: "-all,+gpt-4o-mini",
      },
      stdio: "ignore",
    },
  );
  let stopped = false;
  const exited = new Promise((done) => {
    const onExit = () => {
      stopped = true;
      done();
    };
    app.once("error", onExit);
    app.once("exit", onExit);
  });
  let browser;
  const close = async () => {
    try {
      await browser?.close();
    } finally {
      app.kill("SIGTERM");
      try {
        await provider.close();
      } finally {
        await exited;
      }
    }
  };
  try {
    await until(
      async () => {
        if (stopped) throw Error("NextChat exited before readiness");
        try {
          return (await fetch(url)).ok;
        } catch {
          return false;
        }
      },
      "NextChat readiness",
      120000,
    );
    browser = await chromium.launch({
      channel: process.env.STREAMTRUST_BROWSER_CHANNEL,
    });
  } catch (e) {
    await close();
    throw e;
  }
  return {
    name: "NextChat local UI and IndexedDB",
    metadata: async () => ({
      evidencePolicy: "summary-only-v1",
      provider: "local synthetic",
      browser: browser.version(),
      commit,
    }),
    scenarios: [
      "persistence",
      "cancellation",
      "regeneration.replace-turn",
      "error-retry.replace-turn-same-session",
    ],
    close,
    async run(scenario, { repetition }) {
      const context = await browser.newContext({ locale: "en-US" }),
        page = await context.newPage();
      page.setDefaultTimeout(10000);
      await context.route(
        /^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/,
        (r) => r.abort(),
      );
      const since = provider.calls.length;
      const calls = () =>
        provider.calls.slice(since).filter((x) => typeof x.send === "function");
      const text = async () => page.locator("body").innerText();
      const read = () =>
        page.evaluate(async () => {
          let db, raw;
          try {
            db = await new Promise((ok, fail) => {
              let r = indexedDB.open("keyval-store");
              r.onsuccess = () => ok(r.result);
              r.onerror = () => fail(r.error);
            });
            raw = await new Promise((ok, fail) => {
              let r = db
                .transaction("keyval")
                .objectStore("keyval")
                .get("chat-next-web-store");
              r.onsuccess = () => ok(r.result);
              r.onerror = () => fail(r.error);
            });
          } catch {
            // NextChat falls back to localStorage when idb-keyval is unavailable.
          } finally {
            db?.close();
          }
          const state = JSON.parse(
            raw || localStorage.getItem("chat-next-web-store") || "{}",
          ).state;
          return state?.sessions[state.currentSessionIndex]?.messages || [];
        });
      const regenerate = scenario === "regeneration.replace-turn";
      const retryError = scenario === "error-retry.replace-turn-same-session";
      const retry = regenerate || retryError;
      let original;
      const evidence = {};
      const checks = [];
      const check = (name, passed) => checks.push({ name, passed: !!passed });
      try {
        await page.goto(url + "/#/chat");
        const box = page.locator("textarea:visible").last();
        await box.fill(`Synthetic lifecycle check ${repetition}`);
        await box.press("Enter");
        await until(() => calls().length > 0, "first local provider call");
        let c = calls()[0];
        c.send(c.prefix);
        await until(
          async () => (await text()).includes(c.prefix),
          "first chunk displayed",
        );
        if (scenario === "cancellation") {
          await page
            .getByText("Stop", { exact: true })
            .last()
            .locator("..")
            .click();
          await until(
            async () =>
              !(await page
                .getByText("Stop", { exact: true })
                .last()
                .isVisible()),
            "stop control retired",
            10000,
          );
          if (!c.closed) c.finish();
        } else if (retryError) {
          c.error();
        } else {
          c.finish();
        }
        if (retry) {
          if (regenerate)
            await until(
              async () => (await text()).includes(c.prefix + c.suffix),
              "first answer complete",
            );
          await page
            .getByText("Stop", { exact: true })
            .last()
            .waitFor({ state: "hidden" });
          await page
            .locator('[class*="chat-message"]')
            .filter({ hasText: c.prefix })
            .last()
            .hover();
          const retryButton = page
            .getByText("Retry", { exact: true })
            .last()
            .locator("..");
          await retryButton.waitFor({ state: "visible" });
          const assistants = (await read()).filter(
            (m) => m.role === "assistant",
          );
          original = assistants[0];
          evidence.originalSavedBeforeRetry =
            assistants.length === 1 &&
            typeof original.id === "string" &&
            original.id.length > 0 &&
            (regenerate
              ? original.content === c.prefix + c.suffix &&
                original.streaming === false
              : typeof original.content === "string" &&
                original.content.startsWith(c.prefix) &&
                !original.content.includes(c.suffix));
          check("originalSavedBeforeRetry", evidence.originalSavedBeforeRetry);
          await retryButton.click();
          await until(() => calls().length === 2, "second provider call");
          c = calls()[1];
          c.send(c.prefix);
          c.finish();
        }
        const expected =
          scenario === "cancellation" ? c.prefix : c.prefix + c.suffix;
        await until(
          async () => (await text()).includes(expected),
          "answer visible",
        );
        await until(
          async () =>
            (await read()).some(
              (m) =>
                m.role === "assistant" &&
                typeof m.content === "string" &&
                m.content.includes(c.prefix),
            ),
          "IndexedDB contains displayed text",
        );
        await page.reload();
        await page.locator("textarea:visible").last().waitFor();
        await until(
          async () => (await text()).includes(c.prefix),
          "rehydrated answer",
        );
        const saved = (await read()).filter((m) => m.role === "assistant");
        check(
          "Saved answer equals expected text",
          saved.length === 1 && saved[0].content === expected,
        );
        check(
          "Reload shows expected answer",
          (await text()).includes(expected),
        );
        check("No extra provider call", calls().length === (retry ? 2 : 1));
        if (scenario === "cancellation")
          check(
            "No late completion displayed",
            !(await text()).includes(c.suffix),
          );
        if (retry) {
          evidence.originalAbsentAfterReload =
            !!original?.id && saved.every((m) => m.id !== original.id);
          check(
            "originalAbsentAfterReload",
            evidence.originalAbsentAfterReload,
          );
        }
        return { checks, evidence };
      } catch (error) {
        if (process.env.STREAMTRUST_NEXTCHAT_DEBUG === "1")
          console.error(error);
        throw Error(
          "NextChat scenario could not complete its UI or storage observation",
        );
      } finally {
        for (const c of calls()) if (!c.closed) c.res.end();
        await context.close();
      }
    },
  };
}

export default async function createNextChatAdapter() {
  try {
    return await create();
  } catch {
    throw Error(
      "NextChat setup failed. Check the pinned checkout, dotenv files, Yarn dependencies and Chromium installation.",
    );
  }
}
