/** Stress test for add-connection pick flows. Run: node testChip/test-pick-stress.mjs */

import { chromium } from 'playwright';

import { fileURLToPath } from 'url';

import path from 'path';



const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VisualWaveDrom.html');

const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

let passed = 0, failed = 0;

function assert(l, c) { if (c) { passed++; console.log('  ✓', l); } else { failed++; console.log('  ✗', l); } }



async function withPage(fn, ms = 10000) {

  const browser = await chromium.launch();

  const page = await browser.newPage();

  try {

    await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await page.waitForFunction(() => typeof WaveDrom !== 'undefined', { timeout: 60000 });

    await page.waitForSelector('#wave-container svg', { timeout: 60000 });

    return await Promise.race([fn(page), new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), ms))]);

  } finally { await browser.close(); }

}



async function clickLane(page, idx, frac = 0.5) {

  return page.evaluate(({ idx, frac }) => {

    const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')].filter(g => /^wavelane_\d+_\d+$/.test(g.id));

    const l = lanes[idx]; const b = (l.querySelector('[id^="wavelane_draw_"]')||l).getBoundingClientRect();

    l.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:b.x+b.width*frac,clientY:b.y+b.height/2,view:window}));

  }, { idx, frac });

}



async function clickPreset(page) {

  await page.evaluate(() => document.querySelector('#connection-list .connection-item').click());

  await page.waitForTimeout(600);

}



async function scenario(name, fn, ms = 10000) {

  process.stdout.write(`\n${name}... `);

  try { await withPage(fn, ms); console.log('OK'); }

  catch (e) { failed++; console.log('FAIL:', e.message); }

}



await scenario('first-point-only', async (page) => {

  await page.click('#btn-add-connection');

  await clickLane(page, 0, 0.55);

  assert('from set', !!(await page.evaluate(() => window.__vwdGetConnectionState().connectionFromPoint)));

  assert('presets disabled after start', await page.evaluate(() =>

    [...document.querySelectorAll('#connection-list .connection-item')].every(e => e.classList.contains('disabled'))

  ));

});



await scenario('same-lane two picks', async (page) => {

  await page.click('#btn-add-connection');

  await clickLane(page, 4, 0.2);

  await clickLane(page, 4, 0.85);

  await clickPreset(page);

  assert('inserted', (await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge.length)) >= 2);

});



await scenario('two-lane insert', async (page) => {

  await page.click('#btn-add-connection');

  await clickLane(page, 0, 0.65);

  await clickLane(page, 1, 0.65);

  await clickPreset(page);

  assert('session cleared', !(await page.evaluate(() => window.__vwdGetConnectionState().connectionAddSessionActive)));

  assert('edge inserted', (await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge.length)) >= 2);

});



await scenario('slow user pick flow', async (page) => {

  await page.click('#btn-add-connection');

  await page.waitForTimeout(500);

  await clickLane(page, 0, 0.65);

  await page.waitForTimeout(500);

  await clickLane(page, 1, 0.65);

  await clickPreset(page);

  assert('insert completed', (await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge.length)) >= 2);

}, 15000);



await scenario('toggle pick off/on mid-add', async (page) => {

  await page.click('#btn-add-connection');

  await clickLane(page, 0, 0.5);

  await page.click('#btn-connection-pick');

  await page.click('#btn-add-connection');

  await clickLane(page, 3, 0.35);

  await clickLane(page, 4, 0.35);

  await clickPreset(page);

  assert('insert after re-add', (await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge.length)) >= 2);

}, 15000);



console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);

if (failed > 0) process.exit(1);

