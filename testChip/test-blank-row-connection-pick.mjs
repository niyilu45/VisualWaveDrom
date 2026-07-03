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

async function dismissInlineEdit() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

await page.click('#btn-add-signal');
await page.waitForTimeout(500);
await dismissInlineEdit();

const blankRowIndex = await page.evaluate(() => {
  const p = JSON.parse(document.getElementById('code-editor').value);
  return (p.signal || []).length - 1;
});
assert('blank signal row added at end', blankRowIndex >= 2);

await page.click('#btn-add-connection');
await page.waitForTimeout(200);

async function clickBlankRowAtFrac(rowIdx, frac) {
  await page.evaluate(({ rowIdx, frac }) => {
    const svg = document.querySelector('#wave-container svg');
    const lanes = [...svg.querySelectorAll('g[id^="wavelane_"]')]
      .filter(g => /^wavelane_\d+_\d+$/.test(g.id))
      .sort((a, b) => parseInt(a.id.match(/^wavelane_(\d+)_/)[1], 10) - parseInt(b.id.match(/^wavelane_(\d+)_/)[1], 10));
    const lane = lanes[rowIdx];
    const drawGroup = lane.querySelector('[id^="wavelane_draw_"]');
    const box = drawGroup ? drawGroup.getBoundingClientRect() : lane.getBoundingClientRect();
    lane.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: box.x + box.width * frac,
      clientY: box.y + box.height / 2,
      view: window
    }));
  }, { rowIdx: blankRowIndex, frac });
  await page.waitForTimeout(50);
}

await clickBlankRowAtFrac(blankRowIndex, 0.25);

const afterFirstPick = await page.evaluate((rowIdx) => {
  const state = window.__vwdGetConnectionState();
  const svg = document.querySelector('#wave-container svg');
  const lanes = [...svg.querySelectorAll('g[id^="wavelane_"]')]
    .filter(g => /^wavelane_\d+_\d+$/.test(g.id))
    .sort((a, b) => parseInt(a.id.match(/^wavelane_(\d+)_/)[1], 10) - parseInt(b.id.match(/^wavelane_(\d+)_/)[1], 10));
  const drawGroup = lanes[rowIdx]?.querySelector('[id^="wavelane_draw_"]');
  return {
    from: state.connectionFromPoint,
    hasFromHighlight: !!drawGroup?.querySelector('.wave-col-highlight-from')
  };
}, blankRowIndex);

assert('picked from point on blank row', afterFirstPick.from?.rowIndex === blankRowIndex);

const edgeCountBefore = await page.evaluate(() => {
  const p = JSON.parse(document.getElementById('code-editor').value);
  return (p.edge || []).length;
});

await clickBlankRowAtFrac(blankRowIndex, 0.75);
await page.waitForTimeout(150);
await page.evaluate(() => document.querySelector('#connection-list .connection-item').click());
await page.waitForTimeout(800);

const afterInsert = await page.evaluate((rowIdx) => {
  const p = JSON.parse(document.getElementById('code-editor').value);
  const sig = (p.signal || [])[rowIdx] || {};
  return {
    edgeCount: (p.edge || []).length,
    wave: sig.wave || '',
    node: sig.node || '',
    waveLen: (sig.wave || '').length,
    nodeLen: (sig.node || '').length
  };
}, blankRowIndex);

assert('edge inserted from blank row picks', afterInsert.edgeCount > edgeCountBefore);
assert('blank row wave padded after insert', afterInsert.wave.length > 0);
assert('blank row node length matches wave', afterInsert.waveLen === afterInsert.nodeLen);
assert('blank row node has anchor char', /[a-zA-Z0-9]/.test(afterInsert.node));

await browser.close();
console.log('\nResults:', passed, 'passed,', failed, 'failed');
process.exit(failed > 0 ? 1 : 0);
