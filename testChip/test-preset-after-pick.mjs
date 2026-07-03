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

await page.click('#btn-add-connection');

await page.evaluate(({ frac }) => {

  const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')].filter(g => /^wavelane_\d+_\d+$/.test(g.id));

  const box = (lanes[0].querySelector('[id^="wavelane_draw_"]')||lanes[0]).getBoundingClientRect();

  lanes[0].dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.x + box.width * frac, clientY: box.y + box.height / 2, view: window }));

}, { frac: 0.65 });

assert('presets disabled after start only', await page.evaluate(() =>

  [...document.querySelectorAll('#connection-list .connection-item')].every(el => el.classList.contains('disabled'))

));



const r = await Promise.race([

  (async () => {

    await page.evaluate(({ frac }) => {

      const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')].filter(g => /^wavelane_\d+_\d+$/.test(g.id));

      const box = (lanes[1].querySelector('[id^="wavelane_draw_"]')||lanes[1]).getBoundingClientRect();

      lanes[1].dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.x + box.width * frac, clientY: box.y + box.height / 2, view: window }));

    }, { frac: 0.65 });

    await page.evaluate(() => document.querySelector('#connection-list .connection-item').click());

    await page.waitForTimeout(800);

    return page.evaluate(() => ({

      edgeCount: JSON.parse(document.getElementById('code-editor').value).edge.length,

      status: document.getElementById('status-text').textContent,

      state: window.__vwdGetConnectionState()

    }));

  })(),

  new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 8000))

]);

assert('preset flow ok', !!r);

assert('edge added', r.edgeCount > before);

assert('insert status', r.status.includes('已插入连接'));

assert('points cleared', !r.state.connectionFromPoint);



const before2 = await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge.length);

await page.click('#btn-add-connection');

await page.evaluate(({ frac }) => {

  const lanes = [...document.querySelectorAll('#wave-container g[id^="wavelane_"]')].filter(g => /^wavelane_\d+_\d+$/.test(g.id));

  function c(i) { const box = (lanes[i].querySelector('[id^="wavelane_draw_"]')||lanes[i]).getBoundingClientRect(); lanes[i].dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:box.x+box.width*frac,clientY:box.y+box.height/2,view:window})); }

  c(3); c(4);

}, { frac: 0.35 });

await page.evaluate(() => document.querySelector('#connection-list .connection-item').click());

await page.waitForTimeout(800);

assert('start-end-preset insert', (await page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge.length)) > before2);



await browser.close();

console.log(`\nResults: ${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);

