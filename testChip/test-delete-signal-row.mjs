import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VisualWaveDrom.html');
const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

const browser = await chromium.launch();
const page = await browser.newPage();

let passed = 0;
let failed = 0;

function assert(name, cond) {
  if (cond) {
    console.log('PASS:', name);
    passed++;
  } else {
    console.log('FAIL:', name);
    failed++;
  }
}

await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(() => typeof WaveDrom !== 'undefined', { timeout: 30000 });
await page.waitForSelector('#wave-container svg', { timeout: 30000 });

const initial = await page.evaluate(() => {
  const parsed = JSON.parse(document.getElementById('code-editor').value);
  const btn = document.getElementById('btn-delete-signal');
  return {
    signalCount: parsed.signal.length,
    deleteDisabled: btn.disabled
  };
});

assert('delete button disabled when no row selected', initial.deleteDisabled);

// Select first lane
const firstLane = page.locator('#wave-container g[id^="wavelane_"]').first();
await firstLane.click();
await page.waitForTimeout(300);

const afterSelect = await page.evaluate(() => ({
  deleteDisabled: !document.getElementById('btn-delete-signal').disabled,
  selected: !!document.querySelector('.wave-lane-selected')
}));
assert('delete button enabled after row select', afterSelect.deleteDisabled);
assert('row is selected', afterSelect.selected);

const beforeDelete = await page.evaluate(() => {
  const parsed = JSON.parse(document.getElementById('code-editor').value);
  return { count: parsed.signal.length, firstName: parsed.signal[0].name };
});

await page.click('#btn-delete-signal');
await page.waitForTimeout(500);

const afterDelete = await page.evaluate(() => {
  const parsed = JSON.parse(document.getElementById('code-editor').value);
  const status = document.getElementById('status-text')?.textContent || '';
  const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')]
    .filter(g => /^wavelane_\d+_\d+$/.test(g.id));
  return {
    count: parsed.signal.length,
    status,
    laneCount: lanes.length,
    deleteDisabled: document.getElementById('btn-delete-signal').disabled
  };
});

assert('signal count decreased by 1', afterDelete.count === beforeDelete.count - 1);
assert('status mentions deleted signal', afterDelete.status.includes('已删除信号行'));
assert('status mentions signal name', afterDelete.status.includes(beforeDelete.firstName));
assert('wave lane count matches JSON', afterDelete.laneCount === afterDelete.count);

// Undo delete
await page.keyboard.press('Control+z');
await page.waitForTimeout(500);

const afterUndo = await page.evaluate(() => {
  const parsed = JSON.parse(document.getElementById('code-editor').value);
  return { count: parsed.signal.length, firstName: parsed.signal[0]?.name };
});
assert('undo restores signal count', afterUndo.count === beforeDelete.count);
assert('undo restores signal name', afterUndo.firstName === beforeDelete.firstName);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
