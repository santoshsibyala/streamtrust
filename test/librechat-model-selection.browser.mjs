import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Use the generated, packaged preset and its optional browser dependency.
// The core npm test suite remains dependency-free.
const preset = process.env.STREAMTRUST_LIBRECHAT_TEST_PRESET;
if (!preset) throw new Error('Set STREAMTRUST_LIBRECHAT_TEST_PRESET to an installed LibreChat preset');
const require = createRequire(resolve(preset, 'package.json'));
const { chromium } = require('playwright');
const { ensureFixtureModel } = await import(pathToFileURL(resolve(preset, 'model-selection.mjs')));

async function until(check, label) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timeout: ${label}`);
}

// Mirrors LibreChat's accessible option names and delayed selector display,
// without running an application server or mocking Playwright's locators.
async function fixture(page, { selected = true, ready = false, update = true } = {}) {
  await page.setContent(`
    <style>.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }</style>
    <button aria-label="Select a model">${ready ? 'fixture-model' : 'Select model'}</button>
    <div id="endpoint" hidden role="option">StreamTrust Fixture${selected ? '<span class="sr-only">selected</span>' : ''}</div>
    <div id="model" hidden role="option">fixture-model${selected ? '<span class="sr-only">selected</span>' : ''}</div>
    <script>
    (() => {
      window.clicks = [];
      const button = document.querySelector('button');
      const endpoint = document.querySelector('#endpoint');
      const model = document.querySelector('#model');
      button.onclick = () => { window.clicks.push('selector'); endpoint.hidden = false; };
      endpoint.onclick = () => { window.clicks.push('endpoint'); model.hidden = false; };
      model.onclick = () => {
        window.clicks.push('model');
        if (${update}) setTimeout(() => { button.textContent = 'fixture-model'; }, 150);
      };
    })();
    </script>
  `);
}

test('LibreChat model selection handles accessible selected suffix and delayed readiness', async (t) => {
  const browser = await chromium.launch();
  try {
    for (const selected of [false, true]) {
      await t.test(selected ? 'selected endpoint and model' : 'unselected endpoint and model', async () => {
        const page = await browser.newPage();
        page.setDefaultTimeout(1500);
        try {
          await fixture(page, { selected });
          // Prove the selected fixture reproduces the old exact-name mismatch.
          if (selected) {
            await page.getByRole('button', { name: 'Select a model' }).click();
            assert.equal(await page.getByRole('option', { name: 'StreamTrust Fixture', exact: true }).count(), 0);
            await fixture(page, { selected });
          }
          await ensureFixtureModel(page, until);
          assert.deepEqual(await page.evaluate(() => window.clicks), ['selector', 'endpoint', 'model']);
          assert.equal(await page.getByRole('button', { name: 'Select a model' }).innerText(), 'fixture-model');
        } finally { await page.close(); }
      });
    }
    await t.test('already selected model does not reopen the menu', async () => {
      const page = await browser.newPage();
      try {
        await fixture(page, { ready: true });
        await ensureFixtureModel(page, until);
        assert.deepEqual(await page.evaluate(() => window.clicks), []);
      } finally { await page.close(); }
    });
    await t.test('a model that never becomes ready remains an error', async () => {
      const page = await browser.newPage();
      page.setDefaultTimeout(1500);
      try {
        await fixture(page, { update: false });
        await assert.rejects(ensureFixtureModel(page, until), /Timeout: fixture model ready/);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
