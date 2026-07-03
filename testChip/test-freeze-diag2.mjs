import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VisualWaveDrom.html');
const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

let failed = 0;

async function runScenario(name, fn) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof WaveDrom !== 'undefined', { timeout: 60000 });
    await page.waitForSelector('#wave-container svg', { timeout: 60000 });
    const t0 = Date.now();
    const result = await Promise.race([
      fn(page),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT 20s')), 20000))
    ]);
    console.log(`OK ${name} (${Date.now() - t0}ms):`, JSON.stringify(result));
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}:`, e.message);
  } finally {
    await browser.close();
  }
}

// Scenario 1: Real mouse clicks like test-connection.mjs
await runScenario('mouse-pick-add', async (page) => {
  await page.click('#btn-connection-pick');
  const lanes = page.locator('#wave-container g[id^="wavelane_"]');
  const clkBox = await lanes.nth(0).boundingBox();
  const datBox = await lanes.nth(1).boundingBox();
  await page.mouse.click(clkBox.x + clkBox.width * 0.65, clkBox.y + clkBox.height / 2);
  await page.mouse.click(datBox.x + datBox.width * 0.65, datBox.y + datBox.height / 2);
  const before = await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge.length);
  await page.click('#btn-add-connection');
  await page.waitForTimeout(300);
  return await page.evaluate((beforeCount) => ({
    before: beforeCount,
    after: JSON.parse(document.getElementById('code-editor').value).edge.length,
    edges: JSON.parse(document.getElementById('code-editor').value).edge,
    status: document.getElementById('status-text').textContent
  }), before);
});

// Scenario 2: Auto-insert via preset with pending template
await runScenario('auto-insert-preset', async (page) => {
  await page.click('#btn-connection-pick');
  const lanes = page.locator('#wave-container g[id^="wavelane_"]');
  const clkBox = await lanes.nth(0).boundingBox();
  const busBox = await lanes.nth(2).boundingBox();
  await page.mouse.click(clkBox.x + clkBox.width * 0.25, clkBox.y + clkBox.height / 2);
  await page.mouse.click(busBox.x + busBox.width * 0.35, busBox.y + busBox.height / 2);
  const before = await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge.length);
  await page.locator('#connection-list .connection-item').first().click();
  await page.waitForTimeout(500);
  return await page.evaluate((beforeCount) => ({
    before: beforeCount,
    after: JSON.parse(document.getElementById('code-editor').value).edge.length,
    edges: JSON.parse(document.getElementById('code-editor').value).edge,
    status: document.getElementById('status-text').textContent
  }), before);
});

// Scenario 3: Direct evaluate insertEdge path
await runScenario('direct-insert', async (page) => {
  return await page.evaluate(() => {
    const editor = document.getElementById('code-editor');
    // Reset to default
    editor.value = `{
  "signal": [
    { "name": "clk", "wave": "p.....|", "node": ".a....|" },
    { "name": "dat", "wave": "x.345x|=", "data": ["head", "body", "tail", "data"], "node": "....b..." }
  ],
  "edge": ["a->b"],
  "config": { "hscale": 1 }
}`;
    // Simulate internal state - we need to call render after
    return { note: 'need internal fn access' };
  });
});

if (failed > 0) {
  process.exit(1);
}
