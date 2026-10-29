import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// Pin the workspace root: this app usually sits inside a verification project with its own lockfile.
export default {
  outputFileTracingRoot: root,
  turbopack: { root },
};
