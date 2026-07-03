/** Regression: selected edge must not block insert after pick flow. */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VisualWaveDrom.html');
const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

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

async function clickLane(page, idx, frac = 0.65) {
  await page.evaluate(({ idx, frac }) => {
    const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')]
      .filter(g => /^wavelane_\d+_\d+$/.test(g.id));
    const box = (lanes[idx].querySelector('[id^="wavelane_draw_"]') || lanes[idx]).getBoundingClientRect();
    lanes[idx].dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: box.x + box.width * frac,
      clientY: box.y + box.height / 2,
      view: window
    }));
  }, { idx, frac });
}

const launchOpts = { headless: true };
try {
  launchOpts.channel = 'chrome';
} catch (_) { /* ignore */ }

const browser = await chromium.launch(launchOpts);
try {
  const page = await browser.newPage();
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof WaveDrom !== 'undefined');
  await page.waitForSelector('#wave-container svg');

  await page.locator('#connection-edge-list .connection-edge-row').first().click();
  await page.waitForTimeout(200);
  assert('edge selected before add', await page.evaluate(() => window.__vwdGetConnectionState().selectedEdgeIndex >= 0));

  const before = await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge?.length ?? 0);
  await page.click('#btn-add-connection');
  assert('edge selection cleared on add', await page.evaluate(() => window.__vwdGetConnectionState().selectedEdgeIndex < 0));

  await clickLane(page, 0);
  assert('presets disabled after start only', await page.evaluate(() =>
    [...document.querySelectorAll('#connection-list .connection-item')].every(el => el.classList.contains('disabled'))
  ));

  await clickLane(page, 1);
  assert('presets enabled after end', await page.evaluate(() =>
    [...document.querySelectorAll('#connection-list .connection-item')].some(el => !el.classList.contains('disabled'))
  ));

  await page.locator('#connection-list .connection-item').first().click();
  await page.waitForTimeout(800);

  const after = await page.evaluate(() => ({
    edgeCount: JSON.parse(document.getElementById('code-editor').value).edge?.length ?? 0,
    status: document.getElementById('status-text').textContent,
    state: window.__vwdGetConnectionState()
  }));

  assert('edge inserted with prior selection', after.edgeCount > before);
  assert('insert status', after.status.includes('已插入连接'));
  assert('session cleared', !after.state.connectionAddSessionActive);
  await page.close();
} finally {
  await browser.close();
}

console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
