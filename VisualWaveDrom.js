const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { exec, spawnSync } = require('child_process');

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
const defaultLibraryName = `${path.basename(__filename, '.js')}-library.json`;
const appId = 'VisualWaveDrom';
const protocolScheme = 'visualwavedrom';
let activeProtocolScheme = protocolScheme;
const configuredLibraryOption = commandLineOption('--library');
const configuredLibraryPath = configuredLibraryOption
  ? path.resolve(rootDir, configuredLibraryOption)
  : path.join(rootDir, 'Wave', defaultLibraryName);
if (path.extname(configuredLibraryPath).toLowerCase() !== '.json') {
  throw new Error(`Invalid wave library path: ${configuredLibraryOption}`);
}
const waveDir = path.dirname(configuredLibraryPath);
const configuredLibraryName = path.basename(configuredLibraryPath);
const requestedOpenUrl = commandLineOption('--open-url');
const protocolHandlerPath = commandLineOption('--protocol-handler');
const defaultPort = 4173;
const configuredPort = Number(process.env.PORT);
const preferredPort = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
  ? configuredPort
  : defaultPort;
const noOpen = process.argv.includes('--no-open');
let shutdownTimer = null;
let requestedPort = preferredPort;
let selectingFallbackPort = false;
const connectedClients = new Set();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function newStableId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function writeLibrary(filePath, library) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(library, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function normalizeLibraryIdentity(library) {
  let changed = false;
  if (!library.libraryId || typeof library.libraryId !== 'string') {
    library.libraryId = newStableId('library');
    changed = true;
  }
  if (!Number.isInteger(library.version) || library.version < 2) {
    library.version = 2;
    changed = true;
  }
  library.documents.forEach((document) => {
    if (!document || typeof document !== 'object') return;
    if (!Number.isInteger(document.revision) || document.revision < 0) {
      document.revision = 0;
      changed = true;
    }
  });
  return changed;
}

function readLibrary(filePath, migrate) {
  const library = readJson(filePath);
  if (!library || library.kind !== 'VisualWaveDromWaveLibrary' || !Array.isArray(library.documents)) {
    throw new Error('Invalid library');
  }
  if (normalizeLibraryIdentity(library) && migrate !== false) writeLibrary(filePath, library);
  return library;
}

function isLibraryFile(filePath) {
  try {
    readLibrary(filePath, false);
    return true;
  } catch (_) {
    return false;
  }
}

function ensureWaveDirectory() {
  fs.mkdirSync(waveDir, { recursive: true });
  const defaultPath = configuredLibraryPath;
  if (fs.existsSync(defaultPath)) return;

  let content = '{\n  "signal": []\n}';
  const source = path.join(waveDir, 'default.json');
  if (fs.existsSync(source)) content = fs.readFileSync(source, 'utf8');
  const library = {
    kind: 'VisualWaveDromWaveLibrary',
    version: 2,
    libraryId: newStableId('library'),
    updatedAt: new Date().toISOString(),
    documents: [{
      name: 'default-wave',
      content,
      hscale: 1,
      waveEditMode: 'modify',
      revision: 0,
      savedAt: new Date().toISOString()
    }],
    directories: [],
    activeDocumentName: 'default-wave',
    selectedDirectoryId: 'nav-root'
  };
  writeLibrary(defaultPath, library);
}

function listLibraries() {
  ensureWaveDirectory();
  return fs.readdirSync(waveDir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => ({ name, filePath: path.join(waveDir, name) }))
    .filter(({ filePath }) => isLibraryFile(filePath))
    .map(({ name, filePath }) => {
      const library = readLibrary(filePath, true);
      return { name, libraryId: library.libraryId, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function safeLibraryPath(fileName) {
  const name = path.basename(String(fileName || ''));
  if (!name || name !== fileName || !name.toLowerCase().endsWith('.json')) return null;
  return path.join(waveDir, name);
}

function libraryPathById(libraryId) {
  const id = String(libraryId || '').trim();
  if (!id) return null;
  const item = listLibraries().find((library) => library.libraryId === id);
  return item ? path.join(waveDir, item.name) : null;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (part) => {
      body += part;
      if (body.length > maxBytes) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function normalizedRoot(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function registerProtocolHandler(handlerPath) {
  if (process.platform !== 'win32' || !handlerPath) return;
  const resolved = path.resolve(handlerPath);
  if (!fs.existsSync(resolved) || path.extname(resolved).toLowerCase() !== '.bat') {
    console.warn(`Protocol handler BAT not found: ${resolved}`);
    return;
  }
  const command = `"${process.env.ComSpec || 'cmd.exe'}" /d /s /c ""${resolved}" "%1""`;
  const library = readLibrary(configuredLibraryPath, true);
  const librarySuffix = String(library.libraryId || '')
    .toLowerCase()
    .replace(/[^a-z0-9+.-]/g, '-');
  activeProtocolScheme = librarySuffix ? `${protocolScheme}-${librarySuffix}` : protocolScheme;
  const schemes = Array.from(new Set([activeProtocolScheme, protocolScheme]));
  const commands = schemes.flatMap((scheme) => {
    const key = `HKCU\\Software\\Classes\\${scheme}`;
    return [
      ['add', key, '/ve', '/d', 'URL:VisualWaveDrom Protocol', '/f'],
      ['add', key, '/v', 'URL Protocol', '/t', 'REG_SZ', '/f'],
      ['add', `${key}\\DefaultIcon`, '/ve', '/d', `"${htmlPath}",0`, '/f'],
      ['add', `${key}\\shell\\open\\command`, '/ve', '/d', command, '/f']
    ];
  });
  const results = commands.map((args) => spawnSync('reg.exe', args, { stdio: 'ignore' }));
  const failed = results.some((result) => result.status !== 0);
  if (failed) console.warn('Could not register the VisualWaveDrom URL protocol.');
}

function requestedPagePath(rawUrl) {
  if (!rawUrl) return `/${htmlName}`;
  try {
    const requestUrl = new URL(rawUrl);
    if (requestUrl.protocol !== `${protocolScheme}:`
        && requestUrl.protocol !== `${activeProtocolScheme}:`) return `/${htmlName}`;
    const params = new URLSearchParams();
    ['libraryId', 'waveId', 'view'].forEach((name) => {
      const value = requestUrl.searchParams.get(name);
      if (value) params.set(name, value);
    });
    if (!params.has('view')) params.set('view', 'single');
    return `/open?${params.toString()}`;
  } catch (_) {
    return `/${htmlName}`;
  }
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

function pageAddress(port, rawUrl) {
  return `http://127.0.0.1:${port}${requestedPagePath(rawUrl)}`;
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

function resolveRequestLibraryPath(url, useConfiguredDefault) {
  const byId = libraryPathById(url.searchParams.get('libraryId'));
  if (byId) return byId;
  const fileName = url.searchParams.get('file');
  if (fileName) return safeLibraryPath(fileName);
  return useConfiguredDefault ? configuredLibraryPath : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname === '/open' && req.method === 'GET') {
      const target = new URL(`/${htmlName}`, `http://${req.headers.host || '127.0.0.1'}`);
      url.searchParams.forEach((value, name) => target.searchParams.set(name, value));
      res.writeHead(302, { Location: `${target.pathname}${target.search}` });
      res.end();
      return;
    }
    if (url.pathname === '/api/server-info' && req.method === 'GET') {
      const library = readLibrary(configuredLibraryPath, true);
      sendJson(res, 200, {
        app: appId,
        rootDir,
        htmlName,
        protocolScheme: activeProtocolScheme,
        libraryDir: waveDir,
        currentLibrary: configuredLibraryName,
        currentLibraryId: library.libraryId
      });
      return;
    }
    if (url.pathname === '/api/client-connect' && req.method === 'POST') {
      const clientId = url.searchParams.get('id') || 'legacy-client';
      connectedClients.add(clientId);
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
      sendJson(res, 200, { ok: true, clients: connectedClients.size });
      return;
    }
    if (url.pathname === '/api/client-disconnect' && req.method === 'POST') {
      const clientId = url.searchParams.get('id') || 'legacy-client';
      connectedClients.delete(clientId);
      clearTimeout(shutdownTimer);
      if (connectedClients.size === 0) {
        shutdownTimer = setTimeout(() => {
          server.close(() => process.exit(0));
        }, 1800);
      }
      sendJson(res, 200, { ok: true, clients: connectedClients.size });
      return;
    }
    if (url.pathname === '/api/wave-libraries' && req.method === 'GET') {
      const libraries = listLibraries();
      const configured = libraries.find((item) => item.name === configuredLibraryName);
      const current = configured || libraries[0] || null;
      sendJson(res, 200, {
        files: libraries.map((item) => item.name),
        libraries,
        current: current && current.name,
        currentLibraryId: current && current.libraryId,
        protocolScheme: activeProtocolScheme
      });
      return;
    }
    if (url.pathname === '/api/wave-library') {
      const filePath = resolveRequestLibraryPath(url, true);
      if (!filePath) { sendJson(res, 400, { error: 'Invalid library' }); return; }
      if (req.method === 'GET') {
        if (!fs.existsSync(filePath) || !isLibraryFile(filePath)) { sendJson(res, 404, { error: 'Library not found' }); return; }
        sendJson(res, 200, readLibrary(filePath, true));
        return;
      }
      if (req.method === 'POST') {
        const incoming = JSON.parse(await readRequestBody(req, 20 * 1024 * 1024));
        if (!incoming || incoming.kind !== 'VisualWaveDromWaveLibrary' || !Array.isArray(incoming.documents)) {
          throw new Error('Invalid library');
        }
        const existing = fs.existsSync(filePath) && isLibraryFile(filePath) ? readLibrary(filePath, true) : null;
        if (!incoming.libraryId && existing) incoming.libraryId = existing.libraryId;
        if (existing && incoming.libraryId !== existing.libraryId) {
          sendJson(res, 409, { error: 'Library identity conflict', libraryId: existing.libraryId });
          return;
        }
        normalizeLibraryIdentity(incoming);
        if (existing) {
          const existingByName = new Map(existing.documents
            .filter((document) => document && typeof document.name === 'string')
            .map((document) => [document.name, document]));
          const conflict = incoming.documents.find((document) => {
            const current = document && existingByName.get(document.name);
            if (!current || document.revision === current.revision) return false;
            const sameState = document.content === current.content
              && document.hscale === current.hscale
              && document.waveEditMode === current.waveEditMode;
            if (sameState) {
              document.revision = current.revision;
              return false;
            }
            return true;
          });
          if (conflict) {
            sendJson(res, 409, {
              error: 'Wave document revision conflict',
              waveId: conflict.name
            });
            return;
          }
        }
        incoming.updatedAt = new Date().toISOString();
        writeLibrary(filePath, incoming);
        sendJson(res, 200, { ok: true, file: path.basename(filePath), libraryId: incoming.libraryId });
        return;
      }
    }
    if (url.pathname === '/api/wave-document') {
      if (req.method === 'GET') {
        const filePath = resolveRequestLibraryPath(url, false);
        const waveId = String(url.searchParams.get('waveId') || '');
        if (!filePath || !waveId || !fs.existsSync(filePath)) {
          sendJson(res, 404, { error: 'Wave document not found' });
          return;
        }
        const library = readLibrary(filePath, true);
        const document = library.documents.find((item) => item && item.name === waveId);
        if (!document) { sendJson(res, 404, { error: 'Wave document not found' }); return; }
        sendJson(res, 200, {
          libraryId: library.libraryId,
          file: path.basename(filePath),
          document
        });
        return;
      }
      if (req.method === 'PATCH') {
        const payload = JSON.parse(await readRequestBody(req, 4 * 1024 * 1024));
        const libraryId = String(payload.libraryId || '');
        const waveId = String(payload.waveId || '');
        const filePath = libraryPathById(libraryId);
        if (!filePath || !waveId || !payload.document) {
          sendJson(res, 404, { error: 'Wave document not found' });
          return;
        }
        const library = readLibrary(filePath, true);
        const index = library.documents.findIndex((item) => item && item.name === waveId);
        if (index < 0) { sendJson(res, 404, { error: 'Wave document not found' }); return; }
        const previous = library.documents[index];
        const expectedRevision = Number(payload.expectedRevision);
        if (Number.isInteger(expectedRevision) && expectedRevision !== previous.revision) {
          sendJson(res, 409, { error: 'Wave document revision conflict', document: previous });
          return;
        }
        if (typeof payload.document.content !== 'string') throw new Error('Invalid wave document content');
        JSON.parse(payload.document.content);
        const document = Object.assign({}, previous, payload.document, {
          name: waveId,
          revision: previous.revision + 1,
          savedAt: new Date().toISOString()
        });
        library.documents[index] = document;
        library.updatedAt = new Date().toISOString();
        writeLibrary(filePath, library);
        sendJson(res, 200, { ok: true, libraryId: library.libraryId, file: path.basename(filePath), document });
        return;
      }
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    if (!res.headersSent) sendJson(res, 400, { error: error.message });
    else res.end();
  }
});

ensureWaveDirectory();
registerProtocolHandler(protocolHandlerPath);
if (!fs.existsSync(htmlPath) || !fs.statSync(htmlPath).isFile()) {
  console.error(`HTML file not found: ${htmlPath}`);
  process.exit(1);
}
server.on('listening', () => {
  const serverAddress = server.address();
  const activePort = serverAddress && typeof serverAddress === 'object' ? serverAddress.port : requestedPort;
  const address = pageAddress(activePort, requestedOpenUrl);
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
    && normalizedRoot(info.rootDir) === normalizedRoot(rootDir)
    && normalizedRoot(info.libraryDir) === normalizedRoot(waveDir);

  if (sameService) {
    const address = pageAddress(occupiedPort, requestedOpenUrl);
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
