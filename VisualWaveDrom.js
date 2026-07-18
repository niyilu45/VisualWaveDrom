const fs = require('fs');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');

function commandLineOption(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

const rootDir = __dirname;
const defaultHtmlName = `${path.basename(__filename, '.js')}.html`;
const configuredHtmlName = commandLineOption('--html') || defaultHtmlName;
const htmlName = path.basename(configuredHtmlName);
if (htmlName !== configuredHtmlName || !/\.html?$/i.test(htmlName)) {
  throw new Error(`Invalid HTML file name: ${configuredHtmlName}`);
}
const htmlPath = path.join(rootDir, htmlName);
const waveDir = path.join(rootDir, 'Wave');
const defaultLibraryName = `${path.basename(__filename, '.js')}-library.json`;
const appId = 'VisualWaveDrom';
const defaultPort = 4173;
const configuredPort = Number(process.env.PORT);
const preferredPort = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
  ? configuredPort
  : defaultPort;
const noOpen = process.argv.includes('--no-open');
let shutdownTimer = null;
let requestedPort = preferredPort;
let selectingFallbackPort = false;

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

function normalizedRoot(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function probeServerInfo(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/api/server-info',
      timeout: 800
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (part) => {
        body += part;
        if (body.length > 64 * 1024) {
          request.destroy();
          finish(null);
        }
      });
      response.on('error', () => finish(null));
      response.on('end', () => {
        if (response.statusCode !== 200) { finish(null); return; }
        try {
          finish(JSON.parse(body));
        } catch (_) {
          finish(null);
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      finish(null);
    });
    request.on('error', () => finish(null));
  });
}

function pageAddress(port) {
  return `http://127.0.0.1:${port}/${htmlName}`;
}

function openAddress(address) {
  if (noOpen) return;
  exec(`start "" "${address}"`, (error) => {
    if (error) console.warn(`Could not open the browser automatically: ${error.message}`);
  });
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
  if (url.pathname === '/api/server-info' && req.method === 'GET') {
    sendJson(res, 200, { app: appId, rootDir, htmlName });
    return;
  }
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
if (!fs.existsSync(htmlPath) || !fs.statSync(htmlPath).isFile()) {
  console.error(`HTML file not found: ${htmlPath}`);
  process.exit(1);
}
server.on('listening', () => {
  const serverAddress = server.address();
  const activePort = serverAddress && typeof serverAddress === 'object' ? serverAddress.port : requestedPort;
  const address = pageAddress(activePort);
  if (activePort !== preferredPort) {
    console.log(`Port ${preferredPort} is in use; using available port ${activePort}.`);
  }
  console.log(`VisualWaveDrom is running at ${address}`);
  openAddress(address);
});

server.on('error', async (error) => {
  if (error.code !== 'EADDRINUSE' || selectingFallbackPort) {
    console.error(`VisualWaveDrom failed to start: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const occupiedPort = requestedPort;
  const info = await probeServerInfo(occupiedPort);
  const sameService = info
    && info.app === appId
    && info.htmlName === htmlName
    && normalizedRoot(info.rootDir) === normalizedRoot(rootDir);

  if (sameService) {
    const address = pageAddress(occupiedPort);
    console.log(`VisualWaveDrom is already running at ${address}`);
    openAddress(address);
    return;
  }

  selectingFallbackPort = true;
  requestedPort = 0;
  console.log(`Port ${occupiedPort} is already in use; selecting an available port.`);
  server.listen(0, '127.0.0.1');
});

requestedPort = preferredPort;
server.listen(requestedPort, '127.0.0.1');
