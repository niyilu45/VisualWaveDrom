/**
 * Timing regression: add-connection pick flow with default + large JSON (file://).
 * Run: node testChip/test-add-connection-timing.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VisualWaveDrom.html');
const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
const HANG_MS = 8000;
const MAX_INSERT_MS = 5000;

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

function makeLargeJson(signalCount = 40, waveLen = 180) {
  const signal = [];
  for (let i = 0; i < signalCount; i++) {
    const wave = ('x' + '.'.repeat(Math.max(0, waveLen - 2)) + '|');
    signal.push({ name: 'sig' + i, wave });
  }
  return JSON.stringify({ signal, edge: [], config: { hscale: 1 } }, null, 2);
}

async function clickLaneByIndex(page, laneIdx, frac = 0.65) {
  return page.evaluate(({ laneIdx, frac }) => {
    const svg = document.querySelector('#wave-container svg');
    const lanes = [...svg.querySelectorAll('g[id^="wavelane_"]')]
      .filter(g => /^wavelane_\d+_\d+$/.test(g.id))
      .sort((a, b) => parseInt(a.id.match(/^wavelane_(\d+)_/)[1], 10) - parseInt(b.id.match(/^wavelane_(\d+)_/)[1], 10));
    const lane = lanes[laneIdx];
    if (!lane) return false;
    const drawGroup = lane.querySelector('[id^="wavelane_draw_"]');
    const box = drawGroup ? drawGroup.getBoundingClientRect() : lane.getBoundingClientRect();
    lane.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: box.x + box.width * frac,
      clientY: box.y + box.height / 2,
      view: window
    }));
    return true;
  }, { laneIdx, frac });
}

async function runFlow(page, label, jsonOverride) {
  if (jsonOverride) {
    await page.evaluate((json) => {
      window.__vwdClearPerf?.();
      const editor = document.getElementById('code-editor');
      editor.value = json;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }, jsonOverride);
    await page.waitForSelector('#wave-container svg', { timeout: 30000 });
    await page.waitForTimeout(300);
  }

  const before = await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge?.length ?? 0);
  await page.click('#btn-add-connection');
  await clickLaneByIndex(page, 0, 0.65);
  await page.waitForTimeout(80);

  const t0 = Date.now();
  const result = await Promise.race([
    (async () => {
      await clickLaneByIndex(page, 1, 0.65);
      await page.locator('#connection-list .connection-item').first().click();
      await page.waitForFunction(
        () => document.getElementById('status-text').textContent.includes('已插入连接'),
        { timeout: MAX_INSERT_MS }
      );
      const elapsed = Date.now() - t0;
      return page.evaluate((elapsedMs) => ({
        elapsedMs,
        edgeCount: JSON.parse(document.getElementById('code-editor').value).edge?.length ?? 0,
        status: document.getElementById('status-text').textContent,
        state: window.__vwdGetConnectionState(),
        perf: window.__vwdGetPerf?.() ?? [],
        busy: document.getElementById('wave-container').classList.contains('rendering')
      }), elapsed);
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`HANG > ${HANG_MS}ms (${label})`)), HANG_MS))
  ]);

  assert(`${label}: completes`, !!result);
  assert(`${label}: edge inserted`, result.edgeCount > before);
  assert(`${label}: status ok`, result.status.includes('已插入连接'));
  assert(`${label}: not inserting after`, !result.state.isInsertingEdge);
  assert(`${label}: not busy after`, !result.state.waveformRenderingBusy && !result.busy);
  assert(`${label}: within ${MAX_INSERT_MS}ms`, result.elapsedMs < MAX_INSERT_MS);
  console.log(`  timing ${label}: ${result.elapsedMs}ms, perf marks: ${result.perf.length}`);
  if (result.perf.length) {
    const first = result.perf[0]?.t ?? 0;
    result.perf.forEach((m) => console.log(`    +${Math.round(m.t - first)}ms ${m.label}`));
  }
  return result;
}

const browser = await chromium.launch({ slowMo: 50 });

try {
  {
    const page = await browser.newPage();
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof WaveDrom !== 'undefined', { timeout: 30000 });
    await page.waitForSelector('#wave-container svg', { timeout: 30000 });
    await runFlow(page, 'default-json');
    await page.close();
  }

  {
    const page = await browser.newPage();
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof WaveDrom !== 'undefined', { timeout: 30000 });
    await page.waitForSelector('#wave-container svg', { timeout: 30000 });
    await runFlow(page, 'large-json', makeLargeJson());
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n=== add-connection timing ===`);
console.log('Results:', passed, 'passed,', failed, 'failed');
process.exit(failed > 0 ? 1 : 0);
