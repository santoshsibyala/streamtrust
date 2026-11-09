import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const playwrightVersion = '1.64.1';

export function dependencies(preset) {
  return preset === 'librechat'
    ? { playwright: playwrightVersion, mongodb: '6.20.0', 'mongodb-memory-server': '11.3.0' }
    : { playwright: playwrightVersion };
}

// POSIX shell literals for copyable commands, including paths containing quotes.
export function quote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function installCommand(dir, required = dependencies()) {
  let declared = {};
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    declared = { ...manifest.devDependencies, ...manifest.dependencies };
  } catch { /* Older generated adapters may have no manifest. */ }
  const missing = Object.entries(required).filter(([name]) => !declared[name]);
  const install = missing.length
    ? 'npm install --save-exact ' + missing.map(([name, version]) => name + '@' + version).join(' ')
    : 'npm install';
  return '(cd ' + quote(dir) + ' && ' + install + ' && npx playwright install --with-deps chromium)';
}
