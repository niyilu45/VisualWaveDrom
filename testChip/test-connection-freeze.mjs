/**
 * Consolidated connection-line freeze/hang regression suite (scenarios A–J).
 * Run: node testChip/test-connection-freeze.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VisualWaveDrom.html');
const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
const HANG_MS = 8000;

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

async function withTimeout(promise, label, ms = HANG_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT: ${label} hung > ${ms}ms`)), ms))
  ]);
}

async function openPage(browser) {
  const page = await browser.newPage();
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => typeof WaveDrom !== 'undefined', { timeout: 30000 });
  await page.waitForSelector('#wave-container svg', { timeout: 30000 });
  return page;
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

async function clickDefaultPreset(page) {
  await page.evaluate(() => document.querySelector('#connection-list .connection-item').click());
  await page.waitForTimeout(500);
}

async function addConnectionPickTwo(page, fromIdx = 0, toIdx = 1, frac = 0.65) {
  await page.click('#btn-add-connection');
  await clickLaneByIndex(page, fromIdx, frac);
  await clickLaneByIndex(page, toIdx, frac);
  await clickDefaultPreset(page);
  return page.evaluate(() => {
    const s = window.__vwdGetConnectionState();
    return {
      pickActive: s.connectionPickActive,
      addSession: s.connectionAddSessionActive
    };
  });
}

async function edgeCount(page) {
  return page.evaluate(() => JSON.parse(document.getElementById('code-editor').value).edge?.length ?? 0);
}

async function statusText(page) {
  return page.locator('#status-text').textContent();
}

const browser = await chromium.launch();

try {
  // --- A: 新增连接 → two points → preset insert ---
  {
    const page = await openPage(browser);
    const before = await edgeCount(page);

    const result = await withTimeout((async () => {
      await addConnectionPickTwo(page, 0, 1);
      assert('A: session cleared after pick-insert', !(await page.evaluate(() => window.__vwdGetConnectionState().connectionAddSessionActive)));
      return {
        edgeCount: await edgeCount(page),
        status: await statusText(page),
        state: await page.evaluate(() => window.__vwdGetConnectionState())
      };
    })(), 'A add connection pick two');

    assert('A: completes without hang', !!result);
    assert('A: edge inserted', result.edgeCount > before);
    assert('A: status shows insert', result.status.includes('已插入连接') || result.edgeCount > before);
    assert('A: points cleared', !result.state.connectionFromPoint && !result.state.connectionToPoint);
    await page.close();
  }

  // --- B: 新增连接 → start → end → preset ---
  {
    const page = await openPage(browser);
    const before = await edgeCount(page);
    await page.click('#btn-add-connection');
    await clickLaneByIndex(page, 0, 0.65);
    await clickLaneByIndex(page, 1, 0.65);

    const result = await withTimeout((async () => {
      await clickDefaultPreset(page);
      return {
        edgeCount: await edgeCount(page),
        status: await statusText(page),
        state: await page.evaluate(() => window.__vwdGetConnectionState())
      };
    })(), 'B preset after start');

    assert('B: completes without hang', !!result);
    assert('B: edge inserted via preset', result.edgeCount > before);
    assert('B: insert status shown', result.status.includes('已插入连接') || result.edgeCount > before);
    await page.close();
  }

  // --- C: style preset first does NOT start add flow ---
  {
    const page = await openPage(browser);
    const before = await edgeCount(page);

    const result = await withTimeout((async () => {
      await page.evaluate(() => {
        document.querySelector('#connection-list .connection-item').click();
      });
      await page.waitForTimeout(150);
      const stateAfterStyle = await page.evaluate(() => window.__vwdGetConnectionState());
      if (stateAfterStyle.connectionPickActive) throw new Error('pick mode enabled after style-only click');

      await clickLaneByIndex(page, 0, 0.65);
      await clickLaneByIndex(page, 1, 0.65);
      await page.waitForTimeout(400);

      return {
        edgeCount: await edgeCount(page),
        status: await statusText(page),
        state: await page.evaluate(() => window.__vwdGetConnectionState())
      };
    })(), 'C style first blocked');

    assert('C: completes without hang', !!result);
    assert('C: no edge inserted from style-first', result.edgeCount === before);
    assert('C: add session not active', !result.state.connectionAddSessionActive);
    await page.close();
  }

  // --- D: rapid consecutive style preset clicks (all disabled without session) ---
  {
    const page = await openPage(browser);

    const result = await withTimeout((async () => {
      const presets = page.locator('#connection-list .connection-item');
      const count = await presets.count();
      for (let i = 0; i < Math.min(count, 5); i++) {
        await page.evaluate((idx) => {
          document.querySelectorAll('#connection-list .connection-item')[idx].click();
        }, i);
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(400);
      return {
        status: await statusText(page),
        state: await page.evaluate(() => window.__vwdGetConnectionState()),
        responsive: await page.evaluate(() => document.getElementById('btn-add-connection') !== null)
      };
    })(), 'D rapid preset clicks');

    assert('D: completes without hang', !!result);
    assert('D: page still responsive', result.responsive);
    assert('D: no add session from disabled presets', !result.state.connectionAddSessionActive);
    await page.close();
  }

  // --- E: after insert, rapid consecutive add-connection clicks ---
  {
    const page = await openPage(browser);
    await addConnectionPickTwo(page, 3, 4, 0.35);
    await page.waitForTimeout(400);
    const before = await edgeCount(page);

    const result = await withTimeout((async () => {
      await page.click('#btn-add-connection');
      await page.click('#btn-add-connection');
      await page.click('#btn-add-connection');
      await page.waitForTimeout(200);
      return {
        edgeCount: await edgeCount(page),
        status: await statusText(page),
        state: await page.evaluate(() => window.__vwdGetConnectionState())
      };
    })(), 'E rapid add connection');

    assert('E: completes without hang', !!result);
    assert('E: no duplicate edge from rapid clicks', result.edgeCount === before);
    assert('E: new add session started', result.state.connectionAddSessionActive);
    await page.close();
  }

  // --- F: selected connection → switch style ---
  {
    const page = await openPage(browser);
    await page.locator('#connection-edge-list .connection-edge-row').first().click();
    await page.waitForTimeout(200);

    const result = await withTimeout((async () => {
      await page.locator('#connection-list .connection-item').nth(1).click();
      await page.waitForTimeout(600);
      const edge = await page.evaluate(() => {
        const p = JSON.parse(document.getElementById('code-editor').value);
        return (p.edge || [])[0] || '';
      });
      return { edge, status: await statusText(page) };
    })(), 'F style change on selected');

    assert('F: completes without hang', !!result);
    assert('F: edge style modified', result.edge.split(/\s+/)[0].includes('~>'));
    assert('F: status shows modify', result.status.includes('已修改连接') || result.status.includes('已插入'));
    await page.close();
  }

  // --- G: toggle pick mode on/off during picking ---
  {
    const page = await openPage(browser);
    await page.click('#btn-add-connection');
    await clickLaneByIndex(page, 0, 0.5);

    const result = await withTimeout((async () => {
      await page.click('#btn-connection-pick');
      await page.waitForTimeout(100);
      await page.click('#btn-add-connection');
      await clickLaneByIndex(page, 3, 0.35);
      await clickLaneByIndex(page, 4, 0.35);
      await clickDefaultPreset(page);
      const edgeCountAfter = await edgeCount(page);
      return {
        state: await page.evaluate(() => window.__vwdGetConnectionState()),
        status: await statusText(page),
        edgeCount: edgeCountAfter
      };
    })(), 'G toggle pick mode', 8000);

    assert('G: completes without hang', !!result);
    assert('G: insert completed after re-add', result.status.includes('已插入连接') || result.edgeCount > 1);
    await page.close();
  }

  // --- H: insert connection then Ctrl+Z undo ---
  {
    const page = await openPage(browser);
    const before = await edgeCount(page);
    await addConnectionPickTwo(page, 3, 4, 0.4);
    await page.waitForTimeout(400);
    const afterInsert = await edgeCount(page);
    assert('H: edge inserted before undo', afterInsert > before);

    const result = await withTimeout((async () => {
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(500);
      return {
        edgeCount: await edgeCount(page),
        status: await statusText(page)
      };
    })(), 'H undo after insert');

    assert('H: undo completes without hang', !!result);
    assert('H: edge count restored', result.edgeCount === before);
    await page.close();
  }

  // --- I: insert connection then delete (×) ---
  {
    const page = await openPage(browser);
    const before = await edgeCount(page);
    await addConnectionPickTwo(page, 3, 4, 0.45);
    await page.waitForTimeout(400);
    const afterInsert = await edgeCount(page);
    assert('I: edge inserted before delete', afterInsert > before);

    const result = await withTimeout((async () => {
      await page.locator('#connection-edge-list .connection-edge-delete').last().click();
      await page.waitForTimeout(500);
      return {
        edgeCount: await edgeCount(page),
        rowCount: await page.locator('#connection-edge-list .connection-edge-row').count(),
        status: await statusText(page)
      };
    })(), 'I delete after insert');

    assert('I: delete completes without hang', !!result);
    assert('I: edge removed from JSON', result.edgeCount === before);
    await page.close();
  }

  // --- J: reading mode → exit → operate connections ---
  {
    const page = await openPage(browser);

    const result = await withTimeout((async () => {
      await page.click('#btn-reading-mode');
      await page.waitForTimeout(300);
      const sidebarHidden = await page.evaluate(() =>
        document.querySelector('.app').classList.contains('reading-mode')
      );
      await page.click('#btn-back');
      await page.waitForTimeout(300);
      const sidebarVisible = await page.evaluate(() =>
        !document.querySelector('.app').classList.contains('reading-mode')
      );

      await addConnectionPickTwo(page, 0, 1);
      await page.waitForTimeout(600);

      return {
        wasReading: sidebarHidden,
        sidebarRestored: sidebarVisible,
        edgeCount: await edgeCount(page),
        status: await statusText(page)
      };
    })(), 'J reading mode exit then connect');

    assert('J: completes without hang', !!result);
    assert('J: entered reading mode', result.wasReading);
    assert('J: sidebar restored after exit', result.sidebarRestored);
    assert('J: connection works after reading mode', result.status.includes('已插入连接') || result.edgeCount >= 1);
    await page.close();
  }

} finally {
  await browser.close();
}

console.log('\n=== Connection freeze suite (A–J) ===');
console.log('Results:', passed, 'passed,', failed, 'failed');
process.exit(failed > 0 ? 1 : 0);
