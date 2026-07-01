import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VisualWaveDrom.html');
const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

const browser = await chromium.launch();
const page = await browser.newPage();

page.on('console', (msg) => console.log('PAGE:', msg.text()));
page.on('pageerror', (err) => console.log('ERROR:', err.message));

console.log('Loading page...');
await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof WaveDrom !== 'undefined', { timeout: 60000 });
await page.waitForSelector('#wave-container svg', { timeout: 60000 });
console.log('Page loaded');

// Simulate pick mode + two clicks + add connection via evaluate
const result = await Promise.race([
  page.evaluate(async () => {
    // Enable pick mode
    window.__vwdTest = { steps: [] };
    const log = (s) => window.__vwdTest.steps.push(s);

    // Set connection points directly (clk col 3, dat col 3)
    // Access internal state via triggering UI
    document.getElementById('btn-connection-pick').click();
    log('pick enabled');

    const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')]
      .filter(g => /^wavelane_\d+_\d+$/.test(g.id))
      .sort((a, b) => parseInt(a.id.match(/^wavelane_(\d+)_/)[1], 10) - parseInt(b.id.match(/^wavelane_(\d+)_/)[1], 10));

    log('lanes: ' + lanes.length);

    // Click lane 0 and lane 1
    for (let i = 0; i < 2; i++) {
      const lane = lanes[i];
      const drawGroup = lane.querySelector('[id^="wavelane_draw_"]');
      const box = drawGroup ? drawGroup.getBoundingClientRect() : lane.getBoundingClientRect();
      const x = box.x + box.width * 0.5;
      const y = box.y + box.height / 2;
      lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, view: window }));
      log('clicked lane ' + i);
    }

    const status = document.getElementById('connection-point-status').textContent;
    log('status after picks: ' + status);

    const t0 = performance.now();
    document.getElementById('btn-add-connection').click();
    log('clicked add connection');

    // Wait a tick for sync render
    await new Promise(r => setTimeout(r, 100));

    const elapsed = performance.now() - t0;
    const edgeCount = JSON.parse(document.getElementById('code-editor').value).edge?.length || 0;
    log('elapsed ms: ' + elapsed.toFixed(1));
    log('edge count: ' + edgeCount);
    log('status: ' + document.getElementById('status-text').textContent);

    return window.__vwdTest;
  }),
  new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT 15s')), 15000))
]);

console.log(JSON.stringify(result, null, 2));
await browser.close();
console.log('Done');
