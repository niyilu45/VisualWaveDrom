/** Run connection tests using system Chrome when bundled browsers are missing. */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const tests = [
  'test-connection.mjs',
  'test-preset-after-pick.mjs',
  'test-style-then-pick.mjs',
  'test-connection-freeze.mjs',
  'test-pick-stress.mjs',
  'test-add-connection-pick.mjs',
  'test-blank-row-connection-pick.mjs',
  'test-preset-with-edge-selected.mjs'
];

let totalFailed = 0;

for (const name of tests) {
  const filePath = path.join(dir, name);
  if (!fs.existsSync(filePath)) {
    console.log('SKIP (missing):', name);
    continue;
  }
  let source = fs.readFileSync(filePath, 'utf8');
  if (!source.includes("channel: 'chrome'")) {
    source = source
      .replace(/chromium\.launch\(\{ slowMo: 50 \}\)/g, "chromium.launch({ channel: 'chrome', slowMo: 50 })")
      .replace(/chromium\.launch\(\)/g, "chromium.launch({ channel: 'chrome' })");
  }
  const tmpPath = path.join(dir, `.tmp-${name}`);
  fs.writeFileSync(tmpPath, source);
  console.log('\n===', name, '===');
  const result = spawnSync(process.execPath, [tmpPath], { stdio: 'inherit', cwd: dir });
  fs.unlinkSync(tmpPath);
  if (result.status !== 0) totalFailed++;
}

console.log('\n=== summary ===');
console.log(totalFailed === 0 ? 'ALL PASSED' : `${totalFailed} test file(s) failed`);
process.exit(totalFailed > 0 ? 1 : 0);
