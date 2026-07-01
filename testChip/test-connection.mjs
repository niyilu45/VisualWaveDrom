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

const defaultJson = await page.evaluate(() => document.getElementById('code-editor').value);
assert('default edge uses compact node syntax', defaultJson.includes('"a->b"'));
assert('default clk node length matches wave', defaultJson.includes('"node": ".a....|"'));
assert('default dat node length matches wave', defaultJson.includes('"node": "....b..."'));

const defaultEdgeRender = await page.evaluate(() => {
  const svg = document.querySelector('#wave-container svg');
  const ids = svg ? [...svg.querySelectorAll('[id]')].map((e) => e.id) : [];
  return ids.some((id) => id === 'gmark_a_b');
});
assert('default edge renders in SVG (gmark_a_b)', defaultEdgeRender);

const edgeCountBefore = await page.evaluate(() => {
  const p = JSON.parse(document.getElementById('code-editor').value);
  return (p.edge || []).length;
});

assert('edge list shows default connection', (await page.locator('#connection-edge-list .connection-edge-row').count()) >= 1);

await page.click('#btn-connection-pick');
const lanePick = await page.evaluate(() => {
  const svg = document.querySelector('#wave-container svg');
  const lanes = [...svg.querySelectorAll('g[id^="wavelane_"]')]
    .filter(g => /^wavelane_\d+_\d+$/.test(g.id))
    .sort((a, b) => parseInt(a.id.match(/^wavelane_(\d+)_/)[1], 10) - parseInt(b.id.match(/^wavelane_(\d+)_/)[1], 10));

  function clickLane(idx, frac) {
    const lane = lanes[idx];
    const drawGroup = lane.querySelector('[id^="wavelane_draw_"]');
    const box = drawGroup ? drawGroup.getBoundingClientRect() : lane.getBoundingClientRect();
    lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.x + box.width * frac, clientY: box.y + box.height / 2, view: window }));
  }

  clickLane(0, 0.65);
  clickLane(1, 0.65);
  return {
    laneCount: lanes.length,
    fromRow: window.__vwdGetConnectionState().connectionFromPoint?.rowIndex,
    toRow: window.__vwdGetConnectionState().connectionToPoint?.rowIndex
  };
});
assert('wave lanes rendered', lanePick.laneCount >= 2);
assert('picked two different signal rows', lanePick.fromRow !== lanePick.toRow);

const statusAfterPick = await page.locator('#connection-point-status').textContent();
const colMarkers = (statusAfterPick.match(/\[\d+\]/g) || []).length;
assert('both points shown in status', colMarkers >= 2);

await page.click('#btn-add-connection');
await page.waitForTimeout(500);

const afterInsert = await page.evaluate(() => {
  const text = document.getElementById('code-editor').value;
  const p = JSON.parse(text);
  return {
    edgeCount: (p.edge || []).length,
    edges: p.edge || [],
    text
  };
});

assert(
  'new edge added with compact syntax',
  afterInsert.edgeCount > edgeCountBefore && afterInsert.edges.some((e) => /[a-z]->[a-z]/.test(e.split(/\s+/)[0]))
);

const rowCountBeforeDelete = await page.locator('#connection-edge-list .connection-edge-row').count();
await page.locator('#connection-edge-list .connection-edge-delete').first().click();
await page.waitForTimeout(400);

const afterDelete = await page.evaluate(() => {
  const p = JSON.parse(document.getElementById('code-editor').value);
  return { edgeCount: (p.edge || []).length };
});
const rowCountAfterDelete = await page.locator('#connection-edge-list .connection-edge-row').count();

assert('delete removes edge from JSON', afterDelete.edgeCount === afterInsert.edgeCount - 1);
assert('delete removes row from edge list', rowCountAfterDelete === rowCountBeforeDelete - 1);

// --- Connection selection ---
await page.locator('#connection-edge-list .connection-edge-row').first().click();
await page.waitForTimeout(300);

const afterSelect = await page.evaluate(() => ({
  selectedIndex: window.__vwdSelectedEdgeIndex !== undefined
    ? window.__vwdSelectedEdgeIndex
    : document.querySelector('#connection-edge-list .connection-edge-row.selected') !== null,
  status: document.getElementById('status-text').textContent
}));
assert('click edge row selects connection', afterSelect.selectedIndex !== false || afterSelect.status.includes('已选中连接'));
assert('status shows selected edge', afterSelect.status.includes('已选中连接'));

// --- Style modification preserves label ---
await page.evaluate(() => {
  const editor = document.getElementById('code-editor');
  const p = JSON.parse(editor.value);
  p.edge = ['a->b : hello'];
  editor.value = JSON.stringify(p, null, 2);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(600);
await page.locator('#connection-edge-list .connection-edge-row').first().click();
await page.waitForTimeout(200);

await page.locator('#connection-list .connection-item').nth(1).click();
await page.waitForTimeout(500);

const afterStyleChange = await page.evaluate(() => {
  const p = JSON.parse(document.getElementById('code-editor').value);
  const edge = (p.edge || [])[0] || '';
  return { edge, hasLabel: edge.includes('hello'), isDashed: edge.split(/\s+/)[0].includes('~>') };
});
assert('style change to dashed arrow', afterStyleChange.isDashed);
assert('style change preserves label', afterStyleChange.hasLabel);

// --- Label edit ---
await page.locator('#connection-label-input').fill('world');
await page.click('#btn-apply-edge-label');
await page.waitForTimeout(400);

const afterLabelEdit = await page.evaluate(() => {
  const p = JSON.parse(document.getElementById('code-editor').value);
  return (p.edge || [])[0] || '';
});
assert('label edit updates edge string', afterLabelEdit.includes('world'));

// --- Undo style/label changes ---
await page.keyboard.press('Control+z');
await page.waitForTimeout(400);
await page.keyboard.press('Control+z');
await page.waitForTimeout(400);
const afterUndo = await page.evaluate(() => {
  const p = JSON.parse(document.getElementById('code-editor').value);
  return (p.edge || [])[0] || '';
});
assert('undo restores prior edge state', afterUndo.includes('hello') || afterUndo === 'a->b');

await browser.close();
console.log('\nResults:', passed, 'passed,', failed, 'failed');
process.exit(failed > 0 ? 1 : 0);
