import { dirname } from 'node:path';
import { installCommand } from './browser-setup.js';
import { pathToFileURL } from 'node:url';
import { runVerification, failureReport } from './index.js';
const config = JSON.parse(process.argv[2]);
const controller = new AbortController();
process.once('SIGTERM', () =>
  controller.abort(new Error('Verifier interrupted')),
);
process.once('SIGINT', () =>
  controller.abort(new Error('Verifier interrupted')),
);
process.env.ST_REPORT_DIR = config.outputDir;
let report;
try {
  const module = await import(pathToFileURL(config.adapter).href).catch((error) => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' ||
        !error.message.startsWith("Cannot find package 'playwright' imported from ")) throw error;
    const dir = dirname(config.adapter);
    const message = `Missing package 'playwright' for adapter in ${dir}. Run: ${installCommand(dir)}`;
    console.error(message);
    throw new Error(message);
  });
  if (typeof module.default !== 'function')
    throw new Error('Adapter must export a default async factory');
  const adapter = await module.default({
    outputDir: config.outputDir,
    signal: controller.signal,
  });
  report = await runVerification(
    adapter,
    config.outputDir,
    config.repetitions,
    { signal: controller.signal, runId: config.runId },
  );
} catch (error) {
  report = await failureReport(config.outputDir, config.runId, error);
}
if (process.send)
  await new Promise((r) =>
    process.send(
      { type: 'result', runId: config.runId, exitCode: report.exitCode },
      r,
    ),
  );
// close() has finished; a forgotten adapter timer must not leave CI hanging.
process.exit(report.exitCode);
