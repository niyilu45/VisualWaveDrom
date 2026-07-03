import { chromium } from 'playwright';

import { fileURLToPath } from 'url';

import path from 'path';



const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VisualWaveDrom.html');

const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

const browser = await chromium.launch();

const page = await browser.newPage();

let passed = 0, failed = 0;

function assert(n, c) { if (c) { console.log('PASS:', n); passed++; } else { console.log('FAIL:', n); failed++; } }



await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

await page.waitForFunction(() => typeof WaveDrom !== 'undefined', { timeout: 30000 });

await page.waitForSelector('#wave-container svg', { timeout: 30000 });



const before = await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge.length);

await page.evaluate(() => document.querySelector('#connection-list .connection-item').click());

const s = await page.evaluate(() => window.__vwdGetConnectionState());

assert('style-first no pick mode', !s.connectionPickActive);

assert('style-first no session', !s.connectionAddSessionActive);

assert('style-first no pending template', !s.pendingEdgeTemplate);



await page.click('#btn-add-connection');

await page.evaluate(() => {

  const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')].filter(g => /^wavelane_\d+_\d+$/.test(g.id));

  const l = lanes[0]; const b = (l.querySelector('[id^="wavelane_draw_"]')||l).getBoundingClientRect();

  l.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:b.x+b.width*0.65,clientY:b.y+b.height/2,view:window}));

});

assert('presets disabled after start only', await page.evaluate(() =>

  [...document.querySelectorAll('#connection-list .connection-item')].every(e => e.classList.contains('disabled'))

));

await page.evaluate(() => {

  const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')].filter(g => /^wavelane_\d+_\d+$/.test(g.id));

  const l = lanes[1]; const b = (l.querySelector('[id^="wavelane_draw_"]')||l).getBoundingClientRect();

  l.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:b.x+b.width*0.65,clientY:b.y+b.height/2,view:window}));

});

assert('presets enabled after both points', await page.evaluate(() =>

  [...document.querySelectorAll('#connection-list .connection-item')].every(e => !e.classList.contains('disabled'))

));

await page.evaluate(() => document.querySelector('#connection-list .connection-item').click());

await page.waitForTimeout(800);

const after = await page.evaluate(() => ({ n: JSON.parse(document.getElementById('code-editor').value).edge.length, st: document.getElementById('status-text').textContent, state: window.__vwdGetConnectionState() }));

assert('insert ok', after.n > before);

assert('insert status', after.st.includes('已插入连接'));

assert('session cleared', !after.state.connectionAddSessionActive);

assert('pending template cleared', !after.state.pendingEdgeTemplate);



await browser.close();

console.log(`\nResults: ${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);

