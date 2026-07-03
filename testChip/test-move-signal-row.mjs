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
  return {
    names: parsed.signal.map(s => s.name),
    moveUpDisabled: document.getElementById('btn-move-signal-up').disabled,
    moveDownDisabled: document.getElementById('btn-move-signal-down').disabled
  };
});

assert('move buttons disabled when no row selected', initial.moveUpDisabled && initial.moveDownDisabled);
assert('at least 2 signals for move test', initial.names.length >= 2);

// Select second signal lane (filtered wavelane groups only)
await page.evaluate(() => {
  const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')]
    .filter(g => /^wavelane_\d+_\d+$/.test(g.id))
    .sort((a, b) => parseInt(a.id.match(/^wavelane_(\d+)_/)[1], 10) - parseInt(b.id.match(/^wavelane_(\d+)_/)[1], 10));
  lanes[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(300);

const afterSelect = await page.evaluate(() => ({
  moveUpDisabled: document.getElementById('btn-move-signal-up').disabled,
  moveDownDisabled: document.getElementById('btn-move-signal-down').disabled,
  selected: !!document.querySelector('.wave-lane-selected')
}));
assert('move up enabled on second row', !afterSelect.moveUpDisabled);
assert('move down enabled on second row', !afterSelect.moveDownDisabled);
assert('row is selected', afterSelect.selected);

const beforeMove = await page.evaluate(() => {
  const parsed = JSON.parse(document.getElementById('code-editor').value);
  return parsed.signal.map(s => s.name);
});

await page.click('#btn-move-signal-up');
await page.waitForTimeout(500);

const afterMoveUp = await page.evaluate(() => {
  const parsed = JSON.parse(document.getElementById('code-editor').value);
  const status = document.getElementById('status-text')?.textContent || '';
  const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')]
    .filter(g => /^wavelane_\d+_\d+$/.test(g.id));
  return {
    names: parsed.signal.map(s => s.name),
    status,
    laneCount: lanes.length
  };
});

assert('move up swaps first two names', afterMoveUp.names[0] === beforeMove[1] && afterMoveUp.names[1] === beforeMove[0]);
assert('status mentions moved up', afterMoveUp.status.includes('已上移信号行'));
assert('lane count unchanged', afterMoveUp.laneCount === beforeMove.length);

await page.click('#btn-move-signal-down');
await page.waitForTimeout(500);

const afterMoveDown = await page.evaluate(() => {
  const parsed = JSON.parse(document.getElementById('code-editor').value);
  return parsed.signal.map(s => s.name);
});
assert('move down restores original order', JSON.stringify(afterMoveDown) === JSON.stringify(beforeMove));

// Undo move down
await page.keyboard.press('Control+z');
await page.waitForTimeout(500);

const afterUndo = await page.evaluate(() => {
  const parsed = JSON.parse(document.getElementById('code-editor').value);
  return parsed.signal.map(s => s.name);
});
assert('undo restores swapped order', afterUndo[0] === beforeMove[1] && afterUndo[1] === beforeMove[0]);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
