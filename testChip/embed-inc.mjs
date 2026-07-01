import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, 'VisualWaveDrom.html');
const skinPath = path.join(root, 'inc/skins/default.js');
const wavedromPath = path.join(root, 'inc/wavedrom.min.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const skin = fs.readFileSync(skinPath, 'utf8');
const wavedrom = fs.readFileSync(wavedromPath, 'utf8');

const scriptBreak = /<\/script>/gi;
for (const [name, content] of [['default.js', skin], ['wavedrom.min.js', wavedrom]]) {
  const matches = content.match(scriptBreak);
  if (matches) {
    console.error('WARNING:', name, 'contains', matches.length, '</script> sequence(s)');
  } else {
    console.log('OK:', name, 'no </script> breaks');
  }
}

const eol = html.includes('\r\n') ? '\r\n' : '\n';
const oldRefs =
  `  <script src="inc/skins/default.js"></script>${eol}  <script src="inc/wavedrom.min.js"></script>`;
const replacement = [
  '  <!-- WaveDrom skin + library (inline; source copies in inc/) -->',
  '  <script>',
  skin,
  '  </script>',
  '  <script>',
  wavedrom,
  '  </script>',
].join(eol);

if (!html.includes(oldRefs)) {
  console.error('ERROR: expected script refs not found');
  process.exit(1);
}

const newHtml = html.replace(oldRefs, replacement);
fs.writeFileSync(htmlPath, newHtml, 'utf8');

const stats = fs.statSync(htmlPath);
console.log('Written:', htmlPath);
console.log('Size:', (stats.size / 1024).toFixed(1), 'KB');
console.log('Skin:', (skin.length / 1024).toFixed(1), 'KB');
console.log('Wavedrom:', (wavedrom.length / 1024).toFixed(1), 'KB');
