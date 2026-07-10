const fs = require('fs');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');

const rootDir = __dirname;
const htmlName = `${path.basename(__filename, '.js')}.html`;
const htmlPath = path.join(rootDir, htmlName);
const waveDir = path.join(rootDir, 'Wave');
const defaultLibraryName = `${path.basename(__filename, '.js')}-library.json`;
const port = Number(process.env.PORT) || 4173;
let shutdownTimer = null;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isLibraryFile(filePath) {
  try {
    const data = readJson(filePath);
    return data && data.kind === 'VisualWaveDromWaveLibrary' && Array.isArray(data.documents);
  } catch (_) {
    return false;
  }
}

function ensureWaveDirectory() {
  fs.mkdirSync(waveDir, { recursive: true });
  const defaultPath = path.join(waveDir, defaultLibraryName);
  if (fs.existsSync(defaultPath)) return;

  let content = '{\n  "signal": []\n}';
  const source = path.join(waveDir, 'default.json');
  if (fs.existsSync(source)) content = fs.readFileSync(source, 'utf8');
  const library = {
    kind: 'VisualWaveDromWaveLibrary',
    version: 1,
    updatedAt: new Date().toISOString(),
    documents: [{
      name: 'default-wave',
      content,
      hscale: 1,
      waveEditMode: 'modify',
      savedAt: new Date().toISOString()
    }],
    directories: [],
    activeDocumentName: 'default-wave',
    selectedDirectoryId: 'nav-root'
  };
  fs.writeFileSync(defaultPath, `${JSON.stringify(library, null, 2)}\n`, 'utf8');
}

function listLibraries() {
  ensureWaveDirectory();
  return fs.readdirSync(waveDir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => ({ name, filePath: path.join(waveDir, name) }))
    .filter(({ filePath }) => isLibraryFile(filePath))
    .map(({ name, filePath }) => ({ name, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function safeLibraryPath(fileName) {
  const name = path.basename(String(fileName || ''));
  if (!name || name !== fileName || !name.toLowerCase().endsWith('.json')) return null;
  return path.join(waveDir, name);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? htmlName : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(rootDir, relative);
  if (!target.startsWith(rootDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': contentType(target) });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname === '/api/client-connect' && req.method === 'POST') {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/client-disconnect' && req.method === 'POST') {
    clearTimeout(shutdownTimer);
    shutdownTimer = setTimeout(() => {
      server.close(() => process.exit(0));
    }, 1800);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/wave-libraries' && req.method === 'GET') {
    const libraries = listLibraries();
    sendJson(res, 200, { files: libraries.map((item) => item.name), current: libraries[0] && libraries[0].name });
    return;
  }
  if (url.pathname === '/api/wave-library') {
    const filePath = safeLibraryPath(url.searchParams.get('file'));
    if (!filePath) { sendJson(res, 400, { error: 'Invalid library file name' }); return; }
    if (req.method === 'GET') {
      if (!fs.existsSync(filePath) || !isLibraryFile(filePath)) { sendJson(res, 404, { error: 'Library not found' }); return; }
      sendJson(res, 200, readJson(filePath));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (part) => { body += part; if (body.length > 20 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const library = JSON.parse(body);
          if (!library || library.kind !== 'VisualWaveDromWaveLibrary' || !Array.isArray(library.documents)) throw new Error('Invalid library');
          library.updatedAt = new Date().toISOString();
          const tempPath = `${filePath}.tmp`;
          fs.writeFileSync(tempPath, `${JSON.stringify(library, null, 2)}\n`, 'utf8');
          fs.renameSync(tempPath, filePath);
          sendJson(res, 200, { ok: true, file: path.basename(filePath) });
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
      });
      return;
    }
  }
  serveStatic(req, res, url.pathname);
});

ensureWaveDirectory();
server.listen(port, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${port}/${htmlName}`;
  console.log(`VisualWaveDrom is running at ${address}`);
  if (!process.argv.includes('--no-open')) exec(`start "" "${address}"`);
});
