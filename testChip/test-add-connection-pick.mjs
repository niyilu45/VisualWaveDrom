/** 新增连接 → start → end → preset. Run: node testChip/test-add-connection-pick.mjs */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VisualWaveDrom.html');
const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
let passed = 0, failed = 0;
function assert(n, c) { if (c) { console.log('PASS:', n); passed++; } else { console.log('FAIL:', n); failed++; } }

async function clickLane(page, idx, frac = 0.65) {
  await page.evaluate(({ idx, frac }) => {
    const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')].filter(g => /^wavelane_\d+_\d+$/.test(g.id));
    const box = (lanes[idx].querySelector('[id^="wavelane_draw_"]') || lanes[idx]).getBoundingClientRect();
    lanes[idx].dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.x + box.width * frac, clientY: box.y + box.height / 2, view: window }));
  }, { idx, frac });
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof WaveDrom !== 'undefined');
  await page.waitForSelector('#wave-container svg');
  const before = await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge?.length ?? 0);
  await page.click('#btn-add-connection');
  assert('no pending template on start', !(await page.evaluate(() => window.__vwdGetConnectionState().pendingEdgeTemplate)));
  await clickLane(page, 0);
  assert('presets disabled after start', await page.evaluate(() =>
    [...document.querySelectorAll('#connection-list .connection-item')].every(el => el.classList.contains('disabled'))
  ));
  await clickLane(page, 1);
  assert('presets enabled after end', await page.evaluate(() =>
    [...document.querySelectorAll('#connection-list .connection-item')].some(el => !el.classList.contains('disabled'))
  ));
  await page.evaluate(() => document.querySelector('#connection-list .connection-item').click());
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({
    edgeCount: JSON.parse(document.getElementById('code-editor').value).edge?.length ?? 0,
    status: document.getElementById('status-text').textContent,
    state: window.__vwdGetConnectionState()
  }));
  assert('edge inserted', after.edgeCount > before);
  assert('insert status', after.status.includes('已插入连接'));
  assert('points cleared', !after.state.connectionFromPoint && !after.state.connectionToPoint);
  await page.close();
} finally { await browser.close(); }
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
