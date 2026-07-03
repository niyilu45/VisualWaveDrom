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

await page.click('#btn-add-connection');
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
  const fromAfterFirst = window.__vwdGetConnectionState().connectionFromPoint;
  clickLane(1, 0.65);
  return {
    laneCount: lanes.length,
    fromAfterFirst: fromAfterFirst?.rowIndex,
    colAfterFirst: fromAfterFirst?.colIndex
  };
});
assert('wave lanes rendered', lanePick.laneCount >= 2);
assert('first point recorded before second pick', lanePick.fromAfterFirst != null);

await page.evaluate(() => document.querySelector('#connection-list .connection-item').click());
await page.waitForTimeout(600);

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

const presetHighlightSolid = await page.evaluate(() => window.__vwdGetPresetHighlightIndex());
assert('selected edge highlights solid-arrow preset', presetHighlightSolid === 0);

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

const presetHighlightDashed = await page.evaluate(() => window.__vwdGetPresetHighlightIndex());
assert('style change updates preset highlight to dashed', presetHighlightDashed === 1);

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

// --- Bidirectional arrow (<->) ---
await page.evaluate(() => {
  const editor = document.getElementById('code-editor');
  const p = JSON.parse(editor.value);
  const signals = p.signal || [];
  if (signals[0]) {
    signals[0].wave = signals[0].wave || '01';
    let node = (signals[0].node || '').padEnd(signals[0].wave.length, '.');
    node = node.split('');
    node[1] = 'a';
    signals[0].node = node.join('');
  }
  if (signals[1]) {
    signals[1].wave = signals[1].wave || '01';
    let node = (signals[1].node || '').padEnd(signals[1].wave.length, '.');
    node = node.split('');
    node[2] = 'b';
    signals[1].node = node.join('');
  }
  p.edge = ['a<->b : sync'];
  editor.value = JSON.stringify(p, null, 2);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForFunction(() => {
  const gmark = document.querySelector('#wave-container svg #gmark_a_b');
  const style = gmark?.getAttribute('style') || '';
  return style.includes('marker-start') && style.includes('marker-end');
}, { timeout: 5000 });

const bidirectionalRender = await page.evaluate(() => {
  const svg = document.querySelector('#wave-container svg');
  const gmark = svg ? svg.querySelector('#gmark_a_b') : null;
  const style = gmark ? gmark.getAttribute('style') || '' : '';
  return {
    hasGmark: !!gmark,
    hasBothMarkers: style.includes('marker-start') && style.includes('marker-end')
  };
});
assert('bidirectional edge renders gmark_a_b', bidirectionalRender.hasGmark);
assert('bidirectional edge has marker-start and marker-end', bidirectionalRender.hasBothMarkers);

const bidirectionalPresetIndex = await page.evaluate(() => {
  const items = [...document.querySelectorAll('#connection-list .connection-item')];
  return items.findIndex((el) => el.querySelector('.connection-label')?.textContent === '双向箭头');
});
assert('bidirectional preset exists in connection list', bidirectionalPresetIndex >= 0);

await page.locator('#connection-edge-list .connection-edge-row').first().click();
await page.waitForTimeout(200);
await page.locator('#connection-list .connection-item').nth(bidirectionalPresetIndex).click();
await page.waitForTimeout(500);

const afterBidirectionalStyle = await page.evaluate(() => {
  const p = JSON.parse(document.getElementById('code-editor').value);
  const edge = (p.edge || [])[0] || '';
  const firstWord = edge.split(/\s+/)[0];
  return { edge, isBidirectional: firstWord.includes('<->'), hasLabel: edge.includes('sync') };
});
assert('style change to bidirectional arrow', afterBidirectionalStyle.isBidirectional);
assert('bidirectional style change preserves label', afterBidirectionalStyle.hasLabel);

const presetHighlightBidirectional = await page.evaluate(() => window.__vwdGetPresetHighlightIndex());
assert('bidirectional style updates preset highlight', presetHighlightBidirectional === bidirectionalPresetIndex);

await browser.close();
console.log('\nResults:', passed, 'passed,', failed, 'failed');
process.exit(failed > 0 ? 1 : 0);
