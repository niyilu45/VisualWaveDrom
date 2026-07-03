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

async function setupWireWave(wave) {
  await page.evaluate((w) => {
    const json = { signal: [{ name: 'wire', wave: w }] };
    const editor = document.getElementById('code-editor');
    editor.value = JSON.stringify(json, null, 2);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    localStorage.setItem('vwd-wave-edit-mode', 'modify');
    location.reload();
  }, wave);
  await page.waitForFunction(() => typeof WaveDrom !== 'undefined', { timeout: 30000 });
  await page.waitForSelector('#wave-container svg', { timeout: 30000 });
}

async function selectColumn(rowIndex, colIndex) {
  await page.evaluate(({ rowIndex, colIndex }) => {
    const svg = document.querySelector('#wave-container svg');
    const lanes = [...svg.querySelectorAll('g[id^="wavelane_"]')]
      .filter(g => /^wavelane_\d+_\d+$/.test(g.id))
      .sort((a, b) => parseInt(a.id.match(/^wavelane_(\d+)_/)[1], 10) - parseInt(b.id.match(/^wavelane_(\d+)_/)[1], 10));
    const lane = lanes[rowIndex];
    const drawGroup = lane.querySelector('[id^="wavelane_draw_"]');
    const box = drawGroup ? drawGroup.getBoundingClientRect() : lane.getBoundingClientRect();
    const wave = JSON.parse(document.getElementById('code-editor').value).signal[rowIndex].wave || '';
    const colCount = Math.max(wave.length, 1);
    const frac = (colIndex + 0.5) / colCount;
    const x = box.x + box.width * frac;
    const y = box.y + box.height / 2;
    lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, view: window }));
  }, { rowIndex, colIndex });
  await page.waitForTimeout(300);
}

async function clickLegendChar(char) {
  await page.evaluate((c) => {
    const items = [...document.querySelectorAll('#legend-list .legend-item')];
    const idx = items.findIndex(el => el.querySelector('.legend-char-badge')?.textContent === c);
    if (idx < 0) throw new Error('legend not found: ' + c);
    items[idx].click();
  }, char);
  await page.waitForTimeout(400);
}

async function readState() {
  return page.evaluate(() => {
    const parsed = JSON.parse(document.getElementById('code-editor').value);
    const status = document.getElementById('status-text')?.textContent || '';
    const highlight = document.querySelector('.wave-col-highlight');
    return {
      wave: parsed.signal[0]?.wave || '',
      status,
      hasColHighlight: !!highlight
    };
  });
}

// --- Test: last column append in modify mode ---
await setupWireWave('10');

await selectColumn(0, 1);
const beforeAppend = await readState();
assert('last column selected on wave 10', beforeAppend.wave === '10');

await clickLegendChar('1');
const afterAppend = await readState();
assert('modify last col appends char', afterAppend.wave === '101');
assert('status shows 已在末尾新增', afterAppend.status.includes('已在末尾新增'));
assert('status does not show 已修改 for append', !afterAppend.status.includes('已修改'));
assert('column highlight present after append', afterAppend.hasColHighlight);

// --- Test: non-last column still replaces ---
await setupWireWave('101');

await selectColumn(0, 0);
await clickLegendChar('0');
const afterReplace = await readState();
assert('non-last col replaces char', afterReplace.wave === '001');
assert('status shows 已修改 for replace', afterReplace.status.includes('已修改'));
assert('status shows current next col', afterReplace.status.includes('当前列 [1]'));

// --- Test: empty wave append first char ---
await setupWireWave('');

await selectColumn(0, 0);
await clickLegendChar('1');
const afterEmpty = await readState();
assert('empty wave appends first char', afterEmpty.wave === '1');
assert('empty wave append status', afterEmpty.status.includes('已在末尾新增'));

// --- Test: single char wave append second char ---
await setupWireWave('0');

await selectColumn(0, 0);
await clickLegendChar('1');
const afterSingle = await readState();
assert('single char wave appends second char', afterSingle.wave === '01');
assert('single char append status', afterSingle.status.includes('已在末尾新增'));

console.log(`\nResults: ${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
