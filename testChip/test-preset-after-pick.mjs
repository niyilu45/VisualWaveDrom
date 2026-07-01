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

await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof WaveDrom !== 'undefined', { timeout: 30000 });
await page.waitForSelector('#wave-container svg', { timeout: 30000 });

async function pickTwoPointsViaLanes(page) {
  await page.click('#btn-connection-pick');
  return page.evaluate(() => {
    const svg = document.querySelector('#wave-container svg');
    const lanes = [...svg.querySelectorAll('g[id^="wavelane_"]')]
      .filter(g => /^wavelane_\d+_\d+$/.test(g.id))
      .sort((a, b) => parseInt(a.id.match(/^wavelane_(\d+)_/)[1], 10) - parseInt(b.id.match(/^wavelane_(\d+)_/)[1], 10));

    function clickLane(idx, frac) {
      const lane = lanes[idx];
      const drawGroup = lane.querySelector('[id^="wavelane_draw_"]');
      const box = drawGroup ? drawGroup.getBoundingClientRect() : lane.getBoundingClientRect();
      const x = box.x + box.width * frac;
      const y = box.y + box.height / 2;
      lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, view: window }));
    }

    clickLane(0, 0.65);
    clickLane(1, 0.65);
    const state = window.__vwdGetConnectionState();
    return {
      fromRow: state.connectionFromPoint?.rowIndex,
      toRow: state.connectionToPoint?.rowIndex
    };
  });
}

const edgeCountBefore = await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge.length);

const pickResult = await pickTwoPointsViaLanes(page);
assert('picked two different signal rows', pickResult.fromRow !== pickResult.toRow);

const presetClickResult = await Promise.race([
  (async () => {
    await page.locator('#connection-list .connection-item').first().click();
    await page.waitForTimeout(800);
    return await page.evaluate(() => ({
      edgeCount: JSON.parse(document.getElementById('code-editor').value).edge.length,
      status: document.getElementById('status-text').textContent,
      state: window.__vwdGetConnectionState()
    }));
  })(),
  new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT: preset click hung > 3s')), 3000))
]);

assert('preset insert completes without hang', !!presetClickResult);
assert('new edge added via preset', presetClickResult.edgeCount > edgeCountBefore);
assert('insert status shown', presetClickResult.status.includes('已插入连接'));
assert('connection points cleared after insert', !presetClickResult.state.connectionFromPoint && !presetClickResult.state.connectionToPoint);

// Second insert via 新增连接 — use wire/err rows to avoid node conflicts after first insert
await page.evaluate(() => {
  const btn = document.getElementById('btn-connection-pick');
  if (!window.__vwdGetConnectionState().connectionPickActive) btn.click();

  const svg = document.querySelector('#wave-container svg');
  const lanes = [...svg.querySelectorAll('g[id^="wavelane_"]')]
    .filter(g => /^wavelane_\d+_\d+$/.test(g.id))
    .sort((a, b) => parseInt(a.id.match(/^wavelane_(\d+)_/)[1], 10) - parseInt(b.id.match(/^wavelane_(\d+)_/)[1], 10));

  function clickLane(idx, frac) {
    const lane = lanes[idx];
    const drawGroup = lane.querySelector('[id^="wavelane_draw_"]');
    const box = drawGroup ? drawGroup.getBoundingClientRect() : lane.getBoundingClientRect();
    lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.x + box.width * frac, clientY: box.y + box.height / 2, view: window }));
  }

  clickLane(3, 0.35);
  clickLane(4, 0.35);
});

const beforeAddBtn = await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge.length);

const addBtnResult = await Promise.race([
  (async () => {
    await page.click('#btn-add-connection');
    await page.waitForTimeout(800);
    return await page.evaluate(() => ({
      edgeCount: JSON.parse(document.getElementById('code-editor').value).edge.length,
      status: document.getElementById('status-text').textContent
    }));
  })(),
  new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT: add connection hung > 3s')), 3000))
]);

assert('add connection completes without hang', !!addBtnResult);
assert('add connection inserts edge', addBtnResult.edgeCount > beforeAddBtn);
assert('add connection status shown', addBtnResult.status.includes('已插入连接'));

await browser.close();
console.log('\nResults:', passed, 'passed,', failed, 'failed');
process.exit(failed > 0 ? 1 : 0);
