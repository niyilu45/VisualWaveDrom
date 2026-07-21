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
const monolithicLibraryKind = 'VisualWaveDromWaveLibrary';
const splitLibraryKind = 'VisualWaveDromSplitWaveLibrary';
const protocolScheme = 'visualwavedrom';
let activeProtocolScheme = protocolScheme;
const configuredLibraryOption = commandLineOption('--library');
const configuredLibraryPath = configuredLibraryOption
  ? path.resolve(rootDir, configuredLibraryOption)
  : path.join(rootDir, 'Wave', defaultLibraryName);
if (path.extname(configuredLibraryPath).toLowerCase() !== '.json') {
  throw new Error(`Invalid wave library path: ${configuredLibraryOption}`);
}
const configuredLibraryIsSplit = path.basename(configuredLibraryPath).toLowerCase() === 'library.json';
const configuredLibraryDirectory = path.dirname(configuredLibraryPath);
const waveDir = configuredLibraryIsSplit
  ? path.dirname(configuredLibraryDirectory)
  : path.dirname(configuredLibraryPath);
const configuredLibraryName = configuredLibraryIsSplit
  ? path.basename(configuredLibraryDirectory)
  : path.basename(configuredLibraryPath, path.extname(configuredLibraryPath));
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

function writeJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function writeTextAtomically(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, text, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function splitDocumentPath(manifestPath, relativePath) {
  const root = path.resolve(path.dirname(manifestPath));
  const relative = String(relativePath || '').replace(/\\/g, '/');
  if (!relative || path.isAbsolute(relative)) throw new Error('Invalid split document path');
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Split document path escapes the library');
  return target;
}

function stableSplitDocumentFileName(name) {
  const slug = String(name || 'wave')
    .replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 48) || 'wave';
  const suffix = crypto.createHash('sha256').update(String(name || ''), 'utf8').digest('hex').slice(0, 10);
  return `documents/${slug}-${suffix}.json`;
}

function waveContentMetadata(content, fallbackName) {
  const source = JSON.parse(content);
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Wave document root must be an object');
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const head = source.head && typeof source.head.text === 'string' ? source.head.text.trim() : '';
  return {
    source,
    titleCache: title || head || fallbackName || '',
    descriptionCache: typeof source.description === 'string' ? source.description : ''
  };
}

function splitDocumentMetadata(document, relativeFile) {
  const content = String(document.content == null ? '' : document.content);
  const derived = waveContentMetadata(content, document.name);
  const metadata = Object.assign({}, document, {
    file: relativeFile,
    contentLength: content.length,
    titleCache: derived.titleCache,
    descriptionCache: derived.descriptionCache
  });
  delete metadata.content;
  delete metadata.json;
  delete metadata.deferred;
  return { metadata, source: derived.source };
}

function clientDocumentFromSplit(manifestPath, metadata) {
  const document = Object.assign({}, metadata);
  const documentPath = splitDocumentPath(manifestPath, document.file);
  document.content = fs.readFileSync(documentPath, 'utf8').replace(/[\r\n]+$/, '');
  delete document.file;
  return document;
}

function normalizeSplitManifest(manifest) {
  let changed = normalizeLibraryIdentity(manifest);
  if (manifest.kind !== splitLibraryKind) throw new Error('Invalid split library');
  if (manifest.version !== 3) {
    manifest.version = 3;
    changed = true;
  }
  if (manifest.storage !== 'split-v1') {
    manifest.storage = 'split-v1';
    changed = true;
  }
  if (!Number.isInteger(manifest.sourceLibraryVersion)) {
    manifest.sourceLibraryVersion = 2;
    changed = true;
  }
  return changed;
}

function readLibraryStorage(filePath, migrate) {
  const stored = readJson(filePath);
  if (!stored || !Array.isArray(stored.documents)) throw new Error('Invalid library');
  if (stored.kind === splitLibraryKind) {
    if (normalizeSplitManifest(stored) && migrate !== false) writeJsonAtomically(filePath, stored);
    return { format: 'split', stored };
  }
  if (stored.kind !== monolithicLibraryKind) throw new Error('Invalid library');
  if (normalizeLibraryIdentity(stored) && migrate !== false) writeJsonAtomically(filePath, stored);
  return { format: 'monolithic', stored };
}

function writeSplitLibrary(filePath, library) {
  let existing = null;
  if (fs.existsSync(filePath)) {
    try {
      const raw = readJson(filePath);
      if (raw && raw.kind === splitLibraryKind && Array.isArray(raw.documents)) existing = raw;
    } catch (_) { /* a validated replacement will be written below */ }
  }
  const existingByName = new Map((existing && existing.documents || [])
    .filter((document) => document && typeof document.name === 'string')
    .map((document) => [document.name, document]));
  const manifest = Object.assign({}, library, {
    kind: splitLibraryKind,
    version: 3,
    storage: 'split-v1',
    sourceLibraryVersion: existing && Number.isInteger(existing.sourceLibraryVersion)
      ? existing.sourceLibraryVersion
      : Math.min(2, Math.max(1, Number(library.sourceLibraryVersion || library.version || 2)))
  });
  const metadataDocuments = [];
  const retainedFiles = new Set();
  (library.documents || []).forEach((document) => {
    if (!document || typeof document.name !== 'string' || typeof document.content !== 'string') {
      throw new Error('Invalid wave document');
    }
    const previous = existingByName.get(document.name);
    const relativeFile = previous && previous.file
      ? previous.file
      : stableSplitDocumentFileName(document.name);
    const prepared = splitDocumentMetadata(document, relativeFile);
    const documentPath = splitDocumentPath(filePath, relativeFile);
    writeTextAtomically(documentPath, `${JSON.stringify(prepared.source, null, 2)}\n`);
    metadataDocuments.push(prepared.metadata);
    retainedFiles.add(path.resolve(documentPath));
  });
  manifest.documents = metadataDocuments;
  delete manifest.sourceLibraryVersion;
  manifest.sourceLibraryVersion = existing && Number.isInteger(existing.sourceLibraryVersion)
    ? existing.sourceLibraryVersion
    : Math.min(2, Math.max(1, Number(library.version || 2)));
  writeJsonAtomically(filePath, manifest);
  (existing && existing.documents || []).forEach((document) => {
    if (!document || !document.file) return;
    const oldPath = splitDocumentPath(filePath, document.file);
    if (!retainedFiles.has(path.resolve(oldPath)) && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  });
}

function writeLibrary(filePath, library) {
  let split = false;
  if (fs.existsSync(filePath)) {
    try { split = readJson(filePath).kind === splitLibraryKind; } catch (_) { /* use monolithic fallback */ }
  } else if (path.basename(filePath).toLowerCase() === 'library.json') {
    split = true;
  }
  if (split) writeSplitLibrary(filePath, library);
  else writeJsonAtomically(filePath, library);
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
  const storage = readLibraryStorage(filePath, migrate);
  if (storage.format === 'monolithic') return storage.stored;
  const manifest = storage.stored;
  const library = Object.assign({}, manifest, {
    kind: monolithicLibraryKind,
    documents: manifest.documents.map((metadata) => clientDocumentFromSplit(filePath, metadata))
  });
  delete library.storage;
  delete library.sourceLibraryVersion;
  return library;
}

function summarizeWaveDocument(document) {
  const summary = Object.assign({}, document, {
    deferred: true,
    contentLength: typeof document.content === 'string' ? document.content.length : 0
  });
  delete summary.content;
  let source = null;
  try {
    source = JSON.parse(typeof document.content === 'string' ? document.content : '{}');
  } catch (_) { /* invalid documents remain independently loadable */ }
  const title = source && typeof source.title === 'string' ? source.title.trim() : '';
  const head = source && source.head && typeof source.head.text === 'string'
    ? source.head.text.trim()
    : '';
  summary.titleCache = title || head || document.name || '';
  summary.descriptionCache = source && typeof source.description === 'string'
    ? source.description
    : '';
  return summary;
}

function summarizeLibrary(library) {
  return Object.assign({}, library, {
    documents: library.documents.map(summarizeWaveDocument)
  });
}

function readLibrarySummary(filePath, migrate) {
  const storage = readLibraryStorage(filePath, migrate);
  if (storage.format === 'monolithic') return summarizeLibrary(storage.stored);
  const manifest = storage.stored;
  const summary = Object.assign({}, manifest, {
    kind: monolithicLibraryKind,
    documents: manifest.documents.map((metadata) => {
      const document = Object.assign({}, metadata, { deferred: true });
      delete document.file;
      return document;
    })
  });
  delete summary.storage;
  delete summary.sourceLibraryVersion;
  return summary;
}

function readWaveDocument(filePath, waveId) {
  const storage = readLibraryStorage(filePath, true);
  const document = storage.stored.documents.find((item) => item && item.name === waveId);
  if (!document) return null;
  return storage.format === 'split' ? clientDocumentFromSplit(filePath, document) : document;
}

function updateSplitWaveDocument(filePath, payload) {
  const storage = readLibraryStorage(filePath, true);
  if (storage.format !== 'split') throw new Error('Wave library is not split');
  const manifest = storage.stored;
  const waveId = String(payload.waveId || '');
  const index = manifest.documents.findIndex((item) => item && item.name === waveId);
  if (index < 0) return { status: 404, error: 'Wave document not found' };
  const previous = manifest.documents[index];
  const expectedRevision = Number(payload.expectedRevision);
  if (Number.isInteger(expectedRevision) && expectedRevision !== previous.revision) {
    return { status: 409, error: 'Wave document revision conflict', document: clientDocumentFromSplit(filePath, previous) };
  }
  if (!payload.document || typeof payload.document.content !== 'string') throw new Error('Invalid wave document content');
  const savedAt = new Date().toISOString();
  const document = Object.assign({}, previous, payload.document, {
    name: waveId,
    revision: previous.revision + 1,
    savedAt
  });
  const prepared = splitDocumentMetadata(document, previous.file || stableSplitDocumentFileName(waveId));
  writeTextAtomically(
    splitDocumentPath(filePath, prepared.metadata.file),
    `${JSON.stringify(prepared.source, null, 2)}\n`
  );
  manifest.documents[index] = prepared.metadata;
  manifest.updatedAt = savedAt;
  writeJsonAtomically(filePath, manifest);
  const resultDocument = Object.assign({}, prepared.metadata, { content: document.content });
  delete resultDocument.file;
  return { status: 200, document: resultDocument };
}

function patchSplitLibraryState(filePath, payload) {
  const storage = readLibraryStorage(filePath, true);
  if (storage.format !== 'split') throw new Error('Wave library is not split');
  const manifest = storage.stored;
  const deletedNames = new Set(Array.isArray(payload.deletedDocuments)
    ? payload.deletedDocuments.map((name) => String(name || '')).filter(Boolean)
    : []);
  const deletedFiles = [];
  manifest.documents = manifest.documents.filter((document) => {
    if (!document || !deletedNames.has(document.name)) return true;
    if (document.file) deletedFiles.push(splitDocumentPath(filePath, document.file));
    return false;
  });

  const revisions = [];
  const incomingDocuments = Array.isArray(payload.documents) ? payload.documents : [];
  for (let i = 0; i < incomingDocuments.length; i += 1) {
    const incoming = incomingDocuments[i];
    const name = incoming && String(incoming.name || '').trim();
    if (!name || typeof incoming.content !== 'string') throw new Error('Invalid wave document');
    const index = manifest.documents.findIndex((item) => item && item.name === name);
    const previous = index >= 0 ? manifest.documents[index] : null;
    const expectedRevision = Number(incoming.revision);
    if (previous && Number.isInteger(expectedRevision) && expectedRevision !== previous.revision) {
      const current = clientDocumentFromSplit(filePath, previous);
      const sameState = incoming.content === current.content
        && incoming.hscale === current.hscale
        && incoming.waveEditMode === current.waveEditMode;
      if (!sameState) {
        return { status: 409, error: 'Wave document revision conflict', waveId: name };
      }
      revisions.push({ name, revision: previous.revision, savedAt: previous.savedAt });
      continue;
    }
    const savedAt = new Date().toISOString();
    const document = Object.assign({}, previous || {}, incoming, {
      name,
      revision: previous ? previous.revision + 1 : 0,
      savedAt
    });
    const relativeFile = previous && previous.file ? previous.file : stableSplitDocumentFileName(name);
    const prepared = splitDocumentMetadata(document, relativeFile);
    writeTextAtomically(
      splitDocumentPath(filePath, relativeFile),
      `${JSON.stringify(prepared.source, null, 2)}\n`
    );
    if (index >= 0) manifest.documents[index] = prepared.metadata;
    else manifest.documents.push(prepared.metadata);
    revisions.push({ name, revision: prepared.metadata.revision, savedAt });
  }

  if (Array.isArray(payload.directories)) manifest.directories = payload.directories;
  if (Array.isArray(payload.rootDocuments)) manifest.rootDocuments = payload.rootDocuments;
  if (typeof payload.activeDocumentName === 'string') manifest.activeDocumentName = payload.activeDocumentName;
  if (typeof payload.selectedDirectoryId === 'string') manifest.selectedDirectoryId = payload.selectedDirectoryId;
  manifest.updatedAt = new Date().toISOString();
  writeJsonAtomically(filePath, manifest);
  deletedFiles.forEach((documentPath) => {
    if (fs.existsSync(documentPath)) fs.unlinkSync(documentPath);
  });
  return {
    status: 200,
    revisions,
    deletedDocuments: Array.from(deletedNames)
  };
}

function isLibraryFile(filePath) {
  try {
    readLibraryStorage(filePath, false);
    return true;
  } catch (_) {
    return false;
  }
}

function ensureWaveDirectory() {
  fs.mkdirSync(waveDir, { recursive: true });
  const defaultPath = configuredLibraryPath;
  if (fs.existsSync(defaultPath)) return;

  if (path.basename(defaultPath).toLowerCase() === 'library.json') {
    const libraryDirectory = path.dirname(defaultPath);
    const legacyPath = path.join(path.dirname(libraryDirectory), `${path.basename(libraryDirectory)}.json`);
    if (fs.existsSync(legacyPath) && isLibraryFile(legacyPath)) {
      const legacyLibrary = readLibrary(legacyPath, false);
      writeSplitLibrary(defaultPath, legacyLibrary);
      console.log(`Migrated monolithic wave library to split storage: ${defaultPath}`);
      return;
    }
  }

  let content = '{\n  "signal": []\n}';
  const source = path.join(rootDir, 'Wave', 'default.json');
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

function migrateRootMonolithicLibraries() {
  fs.readdirSync(waveDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .forEach((entry) => {
      const legacyPath = path.join(waveDir, entry.name);
      const libraryName = path.basename(entry.name, path.extname(entry.name));
      const manifestPath = path.join(waveDir, libraryName, 'library.json');
      if (fs.existsSync(manifestPath)) return;
      try {
        const storage = readLibraryStorage(legacyPath, false);
        if (storage.format !== 'monolithic') return;
        writeSplitLibrary(manifestPath, storage.stored);
        console.log(`Migrated monolithic wave library to folder: ${manifestPath}`);
      } catch (_) { /* ordinary WaveDrom JSON files are not libraries */ }
    });
}

function listLibraries() {
  ensureWaveDirectory();
  migrateRootMonolithicLibraries();
  return fs.readdirSync(waveDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, filePath: path.join(waveDir, entry.name, 'library.json') }))
    .filter(({ filePath }) => fs.existsSync(filePath))
    .filter(({ filePath }) => isLibraryFile(filePath))
    .map(({ name, filePath }) => {
      const storage = readLibraryStorage(filePath, true);
      return {
        name,
        libraryId: storage.stored.libraryId,
        documentCount: storage.stored.documents.length,
        mtimeMs: fs.statSync(filePath).mtimeMs
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function safeLibraryPath(libraryName) {
  const requested = String(libraryName || '');
  if (configuredLibraryIsSplit && requested.toLowerCase() === 'library.json') {
    return configuredLibraryPath;
  }
  const name = path.basename(requested);
  if (!name || name !== requested || name === '.' || name === '..') return null;
  return path.join(waveDir, name, 'library.json');
}

function libraryPathById(libraryId) {
  const id = String(libraryId || '').trim();
  if (!id) return null;
  const item = listLibraries().find((library) => library.libraryId === id);
  return item ? path.join(waveDir, item.name, 'library.json') : null;
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
      const library = readLibraryStorage(configuredLibraryPath, true).stored;
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
        const summaryOnly = url.searchParams.get('summary') === '1';
        sendJson(res, 200, summaryOnly ? readLibrarySummary(filePath, true) : readLibrary(filePath, true));
        return;
      }
      if (req.method === 'POST') {
        const incoming = JSON.parse(await readRequestBody(req, 20 * 1024 * 1024));
        if (!incoming || incoming.kind !== monolithicLibraryKind || !Array.isArray(incoming.documents)) {
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
    if (url.pathname === '/api/wave-library-state' && req.method === 'PATCH') {
      const payload = JSON.parse(await readRequestBody(req, 20 * 1024 * 1024));
      const libraryId = String(payload.libraryId || '');
      const filePath = libraryPathById(libraryId);
      if (!filePath) { sendJson(res, 404, { error: 'Wave library not found' }); return; }
      if (readLibraryStorage(filePath, true).format === 'split') {
        const result = patchSplitLibraryState(filePath, payload);
        if (result.status === 409) {
          sendJson(res, 409, { error: result.error, waveId: result.waveId });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          libraryId,
          file: path.basename(filePath),
          revisions: result.revisions,
          deletedDocuments: result.deletedDocuments
        });
        return;
      }
      const library = readLibrary(filePath, true);
      const deletedNames = new Set(Array.isArray(payload.deletedDocuments)
        ? payload.deletedDocuments.map((name) => String(name || '')).filter(Boolean)
        : []);
      if (deletedNames.size > 0) {
        library.documents = library.documents.filter((document) => !deletedNames.has(document && document.name));
      }

      const revisions = [];
      const incomingDocuments = Array.isArray(payload.documents) ? payload.documents : [];
      for (let i = 0; i < incomingDocuments.length; i += 1) {
        const incoming = incomingDocuments[i];
        const name = incoming && String(incoming.name || '').trim();
        if (!name || typeof incoming.content !== 'string') throw new Error('Invalid wave document');
        JSON.parse(incoming.content);
        const index = library.documents.findIndex((item) => item && item.name === name);
        const previous = index >= 0 ? library.documents[index] : null;
        const expectedRevision = Number(incoming.revision);
        if (previous && Number.isInteger(expectedRevision) && expectedRevision !== previous.revision) {
          const sameState = incoming.content === previous.content
            && incoming.hscale === previous.hscale
            && incoming.waveEditMode === previous.waveEditMode;
          if (!sameState) {
            sendJson(res, 409, { error: 'Wave document revision conflict', waveId: name });
            return;
          }
          revisions.push({ name, revision: previous.revision, savedAt: previous.savedAt });
          continue;
        }
        const document = Object.assign({}, previous || {}, incoming, {
          name,
          deferred: undefined,
          titleCache: undefined,
          descriptionCache: undefined,
          contentLength: undefined,
          revision: previous ? previous.revision + 1 : 0,
          savedAt: new Date().toISOString()
        });
        Object.keys(document).forEach((key) => {
          if (document[key] === undefined) delete document[key];
        });
        if (index >= 0) library.documents[index] = document;
        else library.documents.push(document);
        revisions.push({ name, revision: document.revision, savedAt: document.savedAt });
      }

      if (Array.isArray(payload.directories)) library.directories = payload.directories;
      if (Array.isArray(payload.rootDocuments)) library.rootDocuments = payload.rootDocuments;
      if (typeof payload.activeDocumentName === 'string') library.activeDocumentName = payload.activeDocumentName;
      if (typeof payload.selectedDirectoryId === 'string') library.selectedDirectoryId = payload.selectedDirectoryId;
      library.updatedAt = new Date().toISOString();
      writeLibrary(filePath, library);
      sendJson(res, 200, {
        ok: true,
        libraryId: library.libraryId,
        file: path.basename(filePath),
        revisions,
        deletedDocuments: Array.from(deletedNames)
      });
      return;
    }
    if (url.pathname === '/api/wave-document') {
      if (req.method === 'GET') {
        const filePath = resolveRequestLibraryPath(url, false);
        const waveId = String(url.searchParams.get('waveId') || '');
        if (!filePath || !waveId || !fs.existsSync(filePath)) {
          sendJson(res, 404, { error: 'Wave document not found' });
          return;
        }
        const storage = readLibraryStorage(filePath, true);
        const document = readWaveDocument(filePath, waveId);
        if (!document) { sendJson(res, 404, { error: 'Wave document not found' }); return; }
        sendJson(res, 200, {
          libraryId: storage.stored.libraryId,
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
        if (readLibraryStorage(filePath, true).format === 'split') {
          const result = updateSplitWaveDocument(filePath, payload);
          if (result.status !== 200) {
            sendJson(res, result.status, { error: result.error, document: result.document });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            libraryId,
            file: path.basename(filePath),
            document: result.document
          });
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
    && info.currentLibrary === configuredLibraryName
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
