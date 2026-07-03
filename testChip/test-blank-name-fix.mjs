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

await page.click('#btn-add-signal');
await page.waitForTimeout(500);

const afterInsert = await page.evaluate(() => {
  const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')]
    .filter(g => /^wavelane_\d+_\d+$/.test(g.id));
  const last = lanes[lanes.length - 1];
  const zone = last?.querySelector('rect.wave-name-click-zone');
  const zoneRect = zone?.getBoundingClientRect();
  return {
    hasZone: !!zone,
    zoneSize: zoneRect ? { w: zoneRect.width, h: zoneRect.height } : null,
    autoOverlay: !!document.querySelector('.wave-text-edit-overlay'),
    selected: document.querySelector('.wave-lane-selected')?.id
  };
});

assert('blank row gets name click zone', afterInsert.hasZone);
assert('name click zone has hit area', afterInsert.zoneSize && afterInsert.zoneSize.w > 10 && afterInsert.zoneSize.h > 10);
assert('auto-opens name edit after insert', afterInsert.autoOverlay);
assert('blank row is selected', !!afterInsert.selected);

const noClk = await page.evaluate(() => {
  const parsed = JSON.parse(document.getElementById('code-editor').value);
  const last = parsed.signal[parsed.signal.length - 1];
  const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')]
    .filter(g => /^wavelane_\d+_\d+$/.test(g.id));
  const lastLane = lanes[lanes.length - 1];
  const overlay = document.querySelector('.wave-text-edit-overlay');
  const uses = [...(lastLane?.querySelectorAll('[id^="wavelane_draw_"] use') || [])]
    .map(u => u.getAttribute('href') || u.getAttributeNS('http://www.w3.org/1999/xlink', 'href'));
  return {
    lastName: last.name,
    lastWave: last.wave,
    labelText: lastLane?.querySelector('text.info')?.textContent ?? null,
    overlayValue: overlay?.value ?? null,
    hasClockUse: uses.some(h => h && /clk/i.test(h))
  };
});
assert('JSON last row name is empty', noClk.lastName === '');
assert('JSON last row wave is empty', noClk.lastWave === '');
assert('SVG label is not clk', noClk.labelText !== 'clk');
assert('auto-edit overlay value is empty', noClk.overlayValue === '');
assert('blank row wave is not clock pattern', !noClk.hasClockUse);

// Close auto overlay without changing
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

const laneId = afterInsert.selected || await page.evaluate(() => {
  const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')]
    .filter(g => /^wavelane_\d+_\d+$/.test(g.id));
  return lanes[lanes.length - 1]?.id;
});
const zoneBox = await page.locator(`#${laneId} rect.wave-name-click-zone`).boundingBox();
assert('zone bounding box visible', !!zoneBox);

if (zoneBox) {
  await page.mouse.click(zoneBox.x + zoneBox.width / 2, zoneBox.y + zoneBox.height / 2);
}
await page.waitForTimeout(200);

const afterZoneClick = await page.evaluate(() => ({
  hasOverlay: !!document.querySelector('.wave-text-edit-overlay')
}));
assert('clicking name zone opens edit overlay', afterZoneClick.hasOverlay);

if (afterZoneClick.hasOverlay) {
  await page.fill('.wave-text-edit-overlay', 'new_sig');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

const afterRename = await page.evaluate(() => {
  const text = document.getElementById('code-editor').value;
  const parsed = JSON.parse(text);
  const last = parsed.signal[parsed.signal.length - 1];
  const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')]
    .filter(g => /^wavelane_\d+_\d+$/.test(g.id));
  const lastLane = lanes[lanes.length - 1];
  return {
    name: last.name,
    hasZone: !!lastLane?.querySelector('rect.wave-name-click-zone'),
    labelText: lastLane?.querySelector('text.info')?.textContent
  };
});

assert('name saved to JSON', afterRename.name === 'new_sig');
assert('named row removes click zone', !afterRename.hasZone);
assert('label shows new name', afterRename.labelText === 'new_sig');

console.log(`\nResults: ${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
