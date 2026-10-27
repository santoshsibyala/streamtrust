import { mkdir, writeFile, rename, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
export const VERSION = '0.1.0-preview.1';
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) =>
  typeof value === 'string' && value.trim().length > 0;
export function classifyExternal(result) {
  if (!object(result) || !Array.isArray(result.checks)) return 'HARNESS_ERROR';
  if (result.unsupported !== undefined)
    return nonempty(result.unsupported) && result.checks.length === 0
      ? 'UNSUPPORTED'
      : 'HARNESS_ERROR';
  if (
    !result.checks.length ||
    result.checks.some(
      (c) => !object(c) || !nonempty(c.name) || typeof c.passed !== 'boolean',
    )
  )
    return 'HARNESS_ERROR';
  if (new Set(result.checks.map((c) => c.name)).size !== result.checks.length)
    return 'HARNESS_ERROR';
  return result.checks.every((c) => c.passed) ? 'PASS' : 'FAIL';
}
export function validateAdapter(adapter) {
  if (!object(adapter) || !nonempty(adapter.name))
    throw new Error('Adapter must have a nonempty name');
  if (
    !Array.isArray(adapter.scenarios) ||
    !adapter.scenarios.length ||
    adapter.scenarios.some(
      (s) => typeof s !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s),
    )
  )
    throw new Error('Adapter scenarios must be nonempty safe identifiers');
  if (new Set(adapter.scenarios).size !== adapter.scenarios.length)
    throw new Error('Adapter scenario identifiers must be unique');
  for (const method of ['metadata', 'run', 'close'])
    if (typeof adapter[method] !== 'function')
      throw new Error(`Adapter missing ${method}()`);
}
const escape = (value) =>
  String(value)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&apos;',
        })[c],
    );
const jsonSafe = (value) => JSON.parse(JSON.stringify(value ?? null));
export async function writeReports(outputDir, report) {
  await mkdir(outputDir, { recursive: true });
  const rows = report.results;
  const screenshots = new Set();
  await Promise.all(
    rows.map(async (row) => {
      const path = `${row.scenario}-${row.repetition}.png`;
      try {
        await access(resolve(outputDir, path));
        screenshots.add(path);
      } catch {}
    }),
  );
  const suiteCases = report.suiteErrors
    .map(
      (error, i) =>
        `<testcase classname="streamtrust" name="harness-${i}"><error message="${escape(error)}"/></testcase>`,
    )
    .join('');
  const cases = rows
    .map(
      (r) =>
        `<testcase classname="${escape(report.adapter)}" name="${escape(r.scenario)}-${r.repetition}" time="${r.durationMs / 1000}">${r.classification === 'UNSUPPORTED' ? `<skipped message="${escape(r.unsupported)}"/>` : r.classification === 'HARNESS_ERROR' ? `<error message="${escape(r.error || 'Invalid adapter observation')}"/>` : r.classification === 'FAIL' ? `<failure message="Invariant check failed">${escape(JSON.stringify(r.checks))}</failure>` : ''}</testcase>`,
    )
    .join('');
  const junit = `<?xml version="1.0" encoding="UTF-8"?><testsuite name="${escape(report.adapter)}" tests="${rows.length + report.suiteErrors.length}" failures="${report.counts.FAIL ?? 0}" errors="${(report.counts.HARNESS_ERROR ?? 0) + report.suiteErrors.length}" skipped="${report.counts.UNSUPPORTED ?? 0}">${cases}${suiteCases}</testsuite>`;
  const md = `# ${report.adapter}: external application verification\n\nRun: ${report.runId} · StreamTrust ${VERSION} · exit ${report.exitCode}\n\n${JSON.stringify(report.counts)}\n\n| Scenario | Repetition | Result |\n|---|---:|---|\n${rows.map((r) => `| ${r.scenario} | ${r.repetition} | ${r.classification} |`).join('\n')}\n\n${report.suiteErrors.map((e) => `Harness error: ${e}`).join('\n')}\n\nPASS covers only the adapter's declared assertions. FAIL needs review before attribution to an upstream defect. UNSUPPORTED is not a pass. HARNESS_ERROR is inconclusive. See report.json for evidence and junit.xml for CI results.\n`;
  const html = `<!doctype html><meta charset="utf-8"><title>StreamTrust report</title><style>body{max-width:1000px;margin:40px auto;padding:20px;font:16px system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}details{padding:12px;border:1px solid #ddd;margin:12px 0}</style><h1>${escape(report.adapter)}</h1><pre>${escape(md)}</pre><a href="report.json">JSON evidence</a> · <a href="junit.xml">JUnit</a>${rows.map((r) => `<details><summary>${escape(r.scenario)} #${r.repetition}: ${r.classification}</summary><pre>${escape(JSON.stringify(r, null, 2))}</pre>${screenshots.has(`${r.scenario}-${r.repetition}.png`) ? `<img style="max-width:100%" alt="Scenario screenshot" src="${r.scenario}-${r.repetition}.png">` : ''}</details>`).join('')}`;
  for (const [name, value] of Object.entries({
    'report.json': JSON.stringify(report, null, 2),
    'junit.xml': junit,
    'report.md': md,
    'index.html': html,
  })) {
    const tmp = resolve(outputDir, `.${name}.${report.runId}.tmp`);
    await writeFile(tmp, value);
    await rename(tmp, resolve(outputDir, name));
  }
}
export async function failureReport(outputDir, runId, error) {
  const report = {
    schemaVersion: 1,
    version: VERSION,
    runId,
    adapter: 'adapter initialization',
    generatedAt: new Date().toISOString(),
    repetitions: 0,
    scenarios: [],
    metadata: {},
    metadataAfter: {},
    counts: {},
    results: [],
    suiteErrors: [String(error)],
    complete: false,
    exitCode: 2,
  };
  await writeReports(outputDir, report);
  return report;
}
export async function runVerification(
  adapter,
  outputDir,
  repetitions = 3,
  options = {},
) {
  const runId = options.runId ?? randomUUID();
  const results = [];
  const suiteErrors = [];
  let metadata = {},
    metadataAfter = {},
    scenarios = [];
  let name = 'invalid adapter';
  try {
    if (
      !Number.isSafeInteger(repetitions) ||
      repetitions < 1 ||
      repetitions > 1000
    )
      throw new Error('repetitions must be an integer between 1 and 1000');
    validateAdapter(adapter);
    name = adapter.name;
    scenarios = [...adapter.scenarios];
    await mkdir(outputDir, { recursive: true });
    metadata = jsonSafe(await adapter.metadata());
    for (let repetition = 1; repetition <= repetitions; repetition++)
      for (const scenario of scenarios) {
        options.signal?.throwIfAborted();
        const started = Date.now();
        try {
          const observation = jsonSafe(
            await adapter.run(scenario, {
              repetition,
              outputDir: resolve(outputDir),
              signal: options.signal,
            }),
          );
          const classification = classifyExternal(observation);
          // Copy only contract fields; adapter evidence cannot overwrite the verdict or identity.
          const row = {
            scenario,
            repetition,
            classification,
            durationMs: Date.now() - started,
            checks: observation?.checks ?? [],
            evidence: observation?.evidence ?? null,
          };
          if (classification === 'HARNESS_ERROR')
            row.error =
              'Invalid adapter observation: require named boolean checks or explicit unsupported';
          if (classification === 'UNSUPPORTED')
            row.unsupported = observation.unsupported;
          results.push(row);
          console.log(`${classification} ${name} ${scenario} #${repetition}`);
        } catch (error) {
          results.push({
            scenario,
            repetition,
            classification: 'HARNESS_ERROR',
            durationMs: Date.now() - started,
            error: String(error),
            checks: [],
          });
          console.error(`HARNESS_ERROR ${scenario}: ${error}`);
        }
      }
  } catch (error) {
    suiteErrors.push(String(error));
  } finally {
    try {
      if (typeof adapter?.metadata === 'function')
        metadataAfter = jsonSafe(await adapter.metadata());
    } catch (error) {
      suiteErrors.push(`Final metadata: ${error}`);
    }
    try {
      if (typeof adapter?.close === 'function') await adapter.close();
    } catch (error) {
      suiteErrors.push(`Cleanup: ${error}`);
    }
  }
  const counts = results.reduce((a, r) => {
    a[r.classification] = (a[r.classification] ?? 0) + 1;
    return a;
  }, {});
  const complete =
    scenarios.length > 0 && results.length === scenarios.length * repetitions;
  const exitCode =
    suiteErrors.length || !complete || counts.HARNESS_ERROR
      ? 2
      : counts.FAIL || counts.UNSUPPORTED
        ? 1
        : 0;
  const report = {
    schemaVersion: 1,
    version: VERSION,
    runId,
    adapter: name,
    generatedAt: new Date().toISOString(),
    repetitions,
    scenarios,
    metadata,
    metadataAfter,
    counts,
    results,
    suiteErrors,
    complete,
    exitCode,
  };
  await writeReports(outputDir, report);
  return report;
}
// Compatibility for the lab's existing programmatic callers.
export async function verifyExternal(adapter, outputDir, repetitions = 3) {
  return (await runVerification(adapter, outputDir, repetitions)).results;
}
