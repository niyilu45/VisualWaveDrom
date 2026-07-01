import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'VisualWaveDrom.html');
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

await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(() => { localStorage.removeItem('vwd-editor-json'); localStorage.removeItem('vwd-editor-json-valid'); });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof WaveDrom !== 'undefined', { timeout: 30000 });
await page.waitForSelector('#wave-container svg', { timeout: 30000 });

const edgeCountBefore = await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge.length);

await page.evaluate(() => {
  document.getElementById('btn-connection-pick').click();
  const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')]
    .filter((g) => /^wavelane_\d+_\d+$/.test(g.id))
    .sort((a, b) => parseInt(a.id.match(/^wavelane_(\d+)_/)[1], 10) - parseInt(b.id.match(/^wavelane_(\d+)_/)[1], 10));

  function clickLane(lane, frac) {
    const draw = lane.querySelector('[id^="wavelane_draw_"]') || lane;
    const r = draw.getBoundingClientRect();
    const x = r.left + r.width * frac;
    const y = r.top + r.height / 2;
    draw.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
  }

  clickLane(lanes[0], 0.25);
  clickLane(lanes[1], 0.55);
});

const pickState = await page.evaluate(() => window.__vwdGetConnectionState());
assert('both connection points selected', pickState.connectionFromPoint && pickState.connectionToPoint);

const insertStart = Date.now();
await page.click('#btn-add-connection');
await page.waitForFunction(
  () => JSON.parse(document.getElementById('code-editor').value).edge.length > 1,
  { timeout: 5000 }
);
assert('insert completes within 5s (no hang)', Date.now() - insertStart < 5000);

const afterInsert = await page.evaluate(() => ({
  edgeCount: JSON.parse(document.getElementById('code-editor').value).edge.length,
  status: document.getElementById('status-text').textContent
}));

assert('new edge added', afterInsert.edgeCount > edgeCountBefore);
assert('insert status shows success', afterInsert.status.includes('已插入连接'));

await browser.close();
console.log('\nResults:', passed, 'passed,', failed, 'failed');
process.exit(failed > 0 ? 1 : 0);
