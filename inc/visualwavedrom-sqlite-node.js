'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LIBRARY_KIND = 'VisualWaveDromWaveLibrary';
const SQLITE_SCHEMA_VERSION = 2;
const DOCUMENT_CHUNK_THRESHOLD = 256 * 1024;
const DOCUMENT_CHUNK_SIZE = 64 * 1024;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');
const bundledWindowsSqlite = path.join(__dirname, 'sqlite', 'sqlite3.exe');
const bundledUnixSqlite = path.join(__dirname, 'sqlite', 'sqlite3');
const bundledUnixSqliteAvailable = (() => {
  try {
    fs.accessSync(bundledUnixSqlite, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
})();
const configuredSqliteCommand = String(process.env.VWD_SQLITE_EXE || '').trim();
const sqliteCommand = configuredSqliteCommand
  || (process.platform === 'win32'
    ? bundledWindowsSqlite
    : (bundledUnixSqliteAvailable ? bundledUnixSqlite : 'sqlite3'));
const preparedDatabasePaths = new Set();
let sqliteRuntimeInfo = null;

const schemaSql = `
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS vwd_library (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  library_id TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL,
  directories_json TEXT NOT NULL DEFAULT '[]',
  root_documents_json TEXT NOT NULL DEFAULT '[]',
  active_document_name TEXT NOT NULL DEFAULT '',
  selected_directory_id TEXT NOT NULL DEFAULT 'nav-root'
);
CREATE TABLE IF NOT EXISTS vwd_documents (
  name TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  content TEXT NOT NULL,
  hscale REAL NOT NULL DEFAULT 1,
  wave_edit_mode TEXT NOT NULL DEFAULT 'modify',
  revision INTEGER NOT NULL DEFAULT 0,
  saved_at TEXT NOT NULL DEFAULT '',
  title_cache TEXT NOT NULL DEFAULT '',
  description_cache TEXT NOT NULL DEFAULT '',
  content_length INTEGER NOT NULL DEFAULT 0,
  extra_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS vwd_documents_sort_order
  ON vwd_documents(sort_order, name);
CREATE TABLE IF NOT EXISTS vwd_document_chunks (
  document_name TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content_chunk TEXT NOT NULL,
  PRIMARY KEY (document_name, chunk_index),
  FOREIGN KEY (document_name) REFERENCES vwd_documents(name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS vwd_document_chunks_document
  ON vwd_document_chunks(document_name, chunk_index);
PRAGMA user_version=${SQLITE_SCHEMA_VERSION};
`;

function sqliteInstallHint() {
  if (process.platform === 'linux') {
    return 'Install SQLite 3.33 or newer (for example: sudo apt install sqlite3), '
      + 'or set VWD_SQLITE_EXE to the sqlite3 executable.';
  }
  if (process.platform === 'darwin') {
    return 'Install SQLite 3.33 or newer, or set VWD_SQLITE_EXE to the sqlite3 executable.';
  }
  return `SQLite runtime not found: ${sqliteCommand}`;
}

function getRuntimeInfo() {
  if (sqliteRuntimeInfo) return Object.assign({}, sqliteRuntimeInfo);
  const versionResult = spawnSync(sqliteCommand, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  if (versionResult.error) {
    throw new Error(`${sqliteInstallHint()} (${versionResult.error.message})`);
  }
  if (versionResult.status !== 0) {
    const detail = String(versionResult.stderr || versionResult.stdout || '').trim();
    throw new Error(`${sqliteInstallHint()}${detail ? ` (${detail})` : ''}`);
  }

  const probe = spawnSync(sqliteCommand, ['-batch', ':memory:'], {
    input: '.bail on\n.mode json\nSELECT 1 AS ok;\n',
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  const probeOutput = String(probe.stdout || '').trim();
  let jsonModeSupported = false;
  if (!probe.error && probe.status === 0 && probeOutput) {
    try {
      const rows = JSON.parse(probeOutput);
      jsonModeSupported = !!(Array.isArray(rows) && rows[0] && Number(rows[0].ok) === 1);
    } catch (_) {
      jsonModeSupported = false;
    }
  }
  if (!jsonModeSupported) {
    const detail = probe.error
      ? probe.error.message
      : String(probe.stderr || probe.stdout || '').trim();
    throw new Error(
      `SQLite 3.33 or newer with JSON output support is required`
      + `${detail ? ` (${detail})` : ''}`
    );
  }

  const versionText = String(versionResult.stdout || '').trim().split(/\s+/)[0] || 'unknown';
  sqliteRuntimeInfo = {
    command: sqliteCommand,
    version: versionText
  };
  return Object.assign({}, sqliteRuntimeInfo);
}

function runSqlite(filePath, sql, query) {
  getRuntimeInfo();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const script = [
    '.bail on',
    '.timeout 5000',
    'PRAGMA foreign_keys=ON;',
    query ? '.mode json' : '',
    sql,
    ''
  ].filter(Boolean).join('\n');
  const result = spawnSync(sqliteCommand, ['-batch', filePath], {
    input: script,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || 'SQLite command failed').trim());
  }
  if (!query) return [];
  const output = String(result.stdout || '').trim();
  if (!output) return [];
  try {
    return JSON.parse(output);
  } catch (_) {
    throw new Error(`Invalid SQLite JSON output: ${output.slice(0, 200)}`);
  }
}

function execute(filePath, sql) {
  return runSqlite(filePath, sql, false);
}

function query(filePath, sql) {
  return runSqlite(filePath, sql, true);
}

function sqlText(value) {
  return `CAST(X'${Buffer.from(String(value == null ? '' : value), 'utf8').toString('hex')}' AS TEXT)`;
}

function sqlNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : String(fallback);
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(String(value == null ? '' : value));
  } catch (_) {
    return fallback;
  }
}

function ensureSchema(filePath) {
  execute(filePath, schemaSql);
  preparedDatabasePaths.add(path.resolve(filePath));
}

function ensurePortableDatabase(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (preparedDatabasePaths.has(resolvedPath)) return;
  ensureSchema(resolvedPath);
}

function hasSqliteHeader(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < SQLITE_HEADER.length) return false;
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    fs.readSync(fd, header, 0, header.length, 0);
    return header.equals(SQLITE_HEADER);
  } finally {
    fs.closeSync(fd);
  }
}

function isLibraryFile(filePath) {
  if (!hasSqliteHeader(filePath)) return false;
  try {
    const rows = query(filePath, "SELECT kind, library_id FROM vwd_library WHERE singleton=1 LIMIT 1;");
    return !!(rows[0] && rows[0].kind === LIBRARY_KIND && rows[0].library_id);
  } catch (_) {
    return false;
  }
}

function documentContentMetadata(content, fallbackName) {
  const source = JSON.parse(String(content));
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Wave document root must be an object');
  }
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const head = source.head && typeof source.head.text === 'string' ? source.head.text.trim() : '';
  return {
    titleCache: title || head || fallbackName || '',
    descriptionCache: typeof source.description === 'string' ? source.description : ''
  };
}

function safeChunkEnd(text, start, requestedEnd) {
  let end = Math.min(text.length, requestedEnd);
  if (end > start && end < text.length) {
    const previous = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
      end -= 1;
    }
  }
  return end;
}

function splitDocumentContent(content) {
  const text = String(content == null ? '' : content);
  if (text.length < DOCUMENT_CHUNK_THRESHOLD) return [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = safeChunkEnd(text, start, start + DOCUMENT_CHUNK_SIZE);
    if (end <= start) end = Math.min(text.length, start + DOCUMENT_CHUNK_SIZE);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

const knownDocumentFields = new Set([
  'name', 'content', 'json', 'hscale', 'waveEditMode', 'revision', 'savedAt',
  'deferred', 'titleCache', 'descriptionCache', 'contentLength', 'sortOrder'
]);

function prepareDocument(document, sortOrder) {
  if (!document || typeof document.name !== 'string' || typeof document.content !== 'string') {
    throw new Error('Invalid wave document');
  }
  const name = document.name.trim();
  if (!name) throw new Error('Invalid wave document name');
  const metadata = documentContentMetadata(document.content, name);
  const contentChunks = splitDocumentContent(document.content);
  const extra = {};
  Object.keys(document).forEach((key) => {
    if (!knownDocumentFields.has(key) && document[key] !== undefined) extra[key] = document[key];
  });
  return {
    name,
    sortOrder: Number.isInteger(sortOrder) ? sortOrder : Number(document.sortOrder || 0),
    content: document.content,
    inlineContent: contentChunks.length ? '' : document.content,
    contentChunks,
    hscale: Number.isFinite(Number(document.hscale)) ? Number(document.hscale) : 1,
    waveEditMode: document.waveEditMode === 'insert' ? 'insert' : 'modify',
    revision: Number.isInteger(document.revision) && document.revision >= 0 ? document.revision : 0,
    savedAt: typeof document.savedAt === 'string' ? document.savedAt : '',
    titleCache: metadata.titleCache,
    descriptionCache: metadata.descriptionCache,
    contentLength: document.content.length,
    extraJson: JSON.stringify(extra)
  };
}

function documentInsertSql(document) {
  return `INSERT INTO vwd_documents (
    name, sort_order, content, hscale, wave_edit_mode, revision, saved_at,
    title_cache, description_cache, content_length, extra_json
  ) VALUES (
    ${sqlText(document.name)}, ${sqlNumber(document.sortOrder, 0)}, ${sqlText(document.inlineContent)},
    ${sqlNumber(document.hscale, 1)}, ${sqlText(document.waveEditMode)}, ${sqlNumber(document.revision, 0)},
    ${sqlText(document.savedAt)}, ${sqlText(document.titleCache)}, ${sqlText(document.descriptionCache)},
    ${sqlNumber(document.contentLength, 0)}, ${sqlText(document.extraJson)}
  );`;
}

function documentUpsertSql(document) {
  return `${documentInsertSql(document).replace(/;$/, '')}
  ON CONFLICT(name) DO UPDATE SET
    sort_order=excluded.sort_order,
    content=excluded.content,
    hscale=excluded.hscale,
    wave_edit_mode=excluded.wave_edit_mode,
    revision=excluded.revision,
    saved_at=excluded.saved_at,
    title_cache=excluded.title_cache,
    description_cache=excluded.description_cache,
    content_length=excluded.content_length,
    extra_json=excluded.extra_json;`;
}

function documentChunkSql(document) {
  const statements = [
    `DELETE FROM vwd_document_chunks WHERE document_name=${sqlText(document.name)};`
  ];
  document.contentChunks.forEach((chunk, index) => {
    statements.push(`INSERT INTO vwd_document_chunks (
      document_name, chunk_index, content_chunk
    ) VALUES (${sqlText(document.name)}, ${index}, ${sqlText(chunk)});`);
  });
  return statements;
}

function documentWriteSql(document, insertOnly) {
  return [
    insertOnly ? documentInsertSql(document) : documentUpsertSql(document),
    ...documentChunkSql(document)
  ];
}

function normalizeBundle(bundle) {
  if (!bundle || bundle.kind !== LIBRARY_KIND || !Array.isArray(bundle.documents)) {
    throw new Error('Invalid wave library');
  }
  if (!bundle.libraryId || typeof bundle.libraryId !== 'string') {
    throw new Error('Wave library id is required');
  }
  return {
    kind: LIBRARY_KIND,
    version: Math.max(2, Number(bundle.version) || 2),
    libraryId: bundle.libraryId,
    updatedAt: typeof bundle.updatedAt === 'string' ? bundle.updatedAt : new Date().toISOString(),
    directories: Array.isArray(bundle.directories) ? bundle.directories : [],
    rootDocuments: Array.isArray(bundle.rootDocuments) ? bundle.rootDocuments : [],
    activeDocumentName: typeof bundle.activeDocumentName === 'string' ? bundle.activeDocumentName : '',
    selectedDirectoryId: typeof bundle.selectedDirectoryId === 'string' ? bundle.selectedDirectoryId : 'nav-root',
    documents: bundle.documents.map((document, index) => prepareDocument(document, index))
  };
}

function libraryRowSql(library) {
  return `INSERT INTO vwd_library (
    singleton, kind, version, library_id, updated_at, directories_json,
    root_documents_json, active_document_name, selected_directory_id
  ) VALUES (
    1, ${sqlText(library.kind)}, ${sqlNumber(library.version, 2)}, ${sqlText(library.libraryId)},
    ${sqlText(library.updatedAt)}, ${sqlText(JSON.stringify(library.directories))},
    ${sqlText(JSON.stringify(library.rootDocuments))}, ${sqlText(library.activeDocumentName)},
    ${sqlText(library.selectedDirectoryId)}
  ) ON CONFLICT(singleton) DO UPDATE SET
    kind=excluded.kind,
    version=excluded.version,
    library_id=excluded.library_id,
    updated_at=excluded.updated_at,
    directories_json=excluded.directories_json,
    root_documents_json=excluded.root_documents_json,
    active_document_name=excluded.active_document_name,
    selected_directory_id=excluded.selected_directory_id;`;
}

function writeLibrary(filePath, bundle) {
  const library = normalizeBundle(bundle);
  ensureSchema(filePath);
  execute(filePath, [
    'BEGIN IMMEDIATE;',
    'DELETE FROM vwd_documents;',
    'DELETE FROM vwd_library;',
    libraryRowSql(library),
    ...library.documents.flatMap((document) => documentWriteSql(document, true)),
    'COMMIT;'
  ].join('\n'));
  return library;
}

function readLibraryRow(filePath) {
  ensurePortableDatabase(filePath);
  const rows = query(filePath, `SELECT
    kind, version, library_id, updated_at, directories_json, root_documents_json,
    active_document_name, selected_directory_id
    FROM vwd_library WHERE singleton=1 LIMIT 1;`);
  if (!rows[0] || rows[0].kind !== LIBRARY_KIND) throw new Error('Invalid SQLite wave library');
  const row = rows[0];
  return {
    kind: LIBRARY_KIND,
    version: Math.max(2, Number(row.version) || 2),
    libraryId: String(row.library_id || ''),
    updatedAt: String(row.updated_at || ''),
    directories: safeJsonParse(row.directories_json, []),
    rootDocuments: safeJsonParse(row.root_documents_json, []),
    activeDocumentName: String(row.active_document_name || ''),
    selectedDirectoryId: String(row.selected_directory_id || 'nav-root')
  };
}

function documentFromRow(row, summaryOnly, chunkContent) {
  const extra = safeJsonParse(row.extra_json, {});
  const document = Object.assign({}, extra, {
    name: String(row.name || ''),
    hscale: Number(row.hscale),
    waveEditMode: String(row.wave_edit_mode || 'modify'),
    revision: Number(row.revision) || 0,
    savedAt: String(row.saved_at || '')
  });
  if (summaryOnly) {
    document.deferred = true;
    document.titleCache = String(row.title_cache || document.name);
    document.descriptionCache = String(row.description_cache || '');
    document.contentLength = Number(row.content_length) || 0;
  } else {
    document.content = chunkContent === undefined
      ? String(row.content || '')
      : String(chunkContent);
  }
  return document;
}

function readDocumentChunkMap(filePath, documentName) {
  const where = documentName == null
    ? ''
    : ` WHERE document_name=${sqlText(documentName)}`;
  const rows = query(filePath, `SELECT document_name, chunk_index, content_chunk
    FROM vwd_document_chunks${where} ORDER BY document_name, chunk_index;`);
  const chunks = new Map();
  rows.forEach((row) => {
    const name = String(row.document_name || '');
    if (!chunks.has(name)) chunks.set(name, []);
    chunks.get(name).push(String(row.content_chunk || ''));
  });
  const content = new Map();
  chunks.forEach((parts, name) => content.set(name, parts.join('')));
  return content;
}

function readLibrarySummary(filePath) {
  const library = readLibraryRow(filePath);
  const rows = query(filePath, `SELECT name, hscale, wave_edit_mode, revision, saved_at,
    title_cache, description_cache, content_length, extra_json
    FROM vwd_documents ORDER BY sort_order, name;`);
  library.documents = rows.map((row) => documentFromRow(row, true));
  return library;
}

function readLibrary(filePath) {
  const library = readLibraryRow(filePath);
  const chunkContent = readDocumentChunkMap(filePath);
  const rows = query(filePath, `SELECT name, content, hscale, wave_edit_mode, revision, saved_at,
    title_cache, description_cache, content_length, extra_json
    FROM vwd_documents ORDER BY sort_order, name;`);
  library.documents = rows.map((row) => documentFromRow(
    row,
    false,
    chunkContent.has(String(row.name || '')) ? chunkContent.get(String(row.name || '')) : undefined
  ));
  return library;
}

function readWaveDocument(filePath, waveId) {
  ensurePortableDatabase(filePath);
  const rows = query(filePath, `SELECT name, content, hscale, wave_edit_mode, revision, saved_at,
    title_cache, description_cache, content_length, extra_json
    FROM vwd_documents WHERE name=${sqlText(waveId)} LIMIT 1;`);
  if (!rows[0]) return null;
  const chunks = readDocumentChunkMap(filePath, waveId);
  return documentFromRow(
    rows[0],
    false,
    chunks.has(String(rows[0].name || '')) ? chunks.get(String(rows[0].name || '')) : undefined
  );
}

function nextSortOrder(filePath) {
  const rows = query(filePath, 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM vwd_documents;');
  return Number(rows[0] && rows[0].next_order) || 0;
}

function updateWaveDocument(filePath, payload) {
  ensurePortableDatabase(filePath);
  const waveId = String(payload.waveId || '');
  const previous = readWaveDocument(filePath, waveId);
  if (!previous) return { status: 404, error: 'Wave document not found' };
  const expectedRevision = Number(payload.expectedRevision);
  if (Number.isInteger(expectedRevision) && expectedRevision !== previous.revision) {
    return { status: 409, error: 'Wave document revision conflict', document: previous };
  }
  if (!payload.document || typeof payload.document.content !== 'string') {
    throw new Error('Invalid wave document content');
  }
  const savedAt = new Date().toISOString();
  const sortRows = query(filePath, `SELECT sort_order FROM vwd_documents WHERE name=${sqlText(waveId)} LIMIT 1;`);
  const document = prepareDocument(Object.assign({}, previous, payload.document, {
    name: waveId,
    revision: previous.revision + 1,
    savedAt
  }), Number(sortRows[0] && sortRows[0].sort_order) || 0);
  execute(filePath, [
    'BEGIN IMMEDIATE;',
    ...documentWriteSql(document, false),
    `UPDATE vwd_library SET updated_at=${sqlText(savedAt)} WHERE singleton=1;`,
    'COMMIT;'
  ].join('\n'));
  return { status: 200, document: documentFromRow({
    name: document.name,
    content: document.content,
    hscale: document.hscale,
    wave_edit_mode: document.waveEditMode,
    revision: document.revision,
    saved_at: document.savedAt,
    extra_json: document.extraJson
  }, false) };
}

function patchLibraryState(filePath, payload) {
  ensurePortableDatabase(filePath);
  const library = readLibraryRow(filePath);
  const deletedNames = new Set(Array.isArray(payload.deletedDocuments)
    ? payload.deletedDocuments.map((name) => String(name || '')).filter(Boolean)
    : []);
  const incomingDocuments = Array.isArray(payload.documents) ? payload.documents : [];
  const preparedDocuments = [];
  const revisions = [];
  let sortOrder = nextSortOrder(filePath);

  for (let index = 0; index < incomingDocuments.length; index += 1) {
    const incoming = incomingDocuments[index];
    const name = incoming && String(incoming.name || '').trim();
    if (!name || typeof incoming.content !== 'string') throw new Error('Invalid wave document');
    const previous = readWaveDocument(filePath, name);
    const expectedRevision = Number(incoming.revision);
    if (previous && Number.isInteger(expectedRevision) && expectedRevision !== previous.revision) {
      const sameState = incoming.content === previous.content
        && Number(incoming.hscale) === Number(previous.hscale)
        && incoming.waveEditMode === previous.waveEditMode;
      if (!sameState) return { status: 409, error: 'Wave document revision conflict', waveId: name };
      revisions.push({ name, revision: previous.revision, savedAt: previous.savedAt });
      continue;
    }
    let currentSortOrder = sortOrder++;
    if (previous) {
      const rows = query(filePath, `SELECT sort_order FROM vwd_documents WHERE name=${sqlText(name)} LIMIT 1;`);
      currentSortOrder = Number(rows[0] && rows[0].sort_order) || 0;
    }
    const savedAt = new Date().toISOString();
    const document = prepareDocument(Object.assign({}, previous || {}, incoming, {
      name,
      revision: previous ? previous.revision + 1 : 0,
      savedAt
    }), currentSortOrder);
    preparedDocuments.push(document);
    revisions.push({ name, revision: document.revision, savedAt });
  }

  const updated = Object.assign({}, library, {
    directories: Array.isArray(payload.directories) ? payload.directories : library.directories,
    rootDocuments: Array.isArray(payload.rootDocuments) ? payload.rootDocuments : library.rootDocuments,
    activeDocumentName: typeof payload.activeDocumentName === 'string'
      ? payload.activeDocumentName : library.activeDocumentName,
    selectedDirectoryId: typeof payload.selectedDirectoryId === 'string'
      ? payload.selectedDirectoryId : library.selectedDirectoryId,
    updatedAt: new Date().toISOString()
  });
  execute(filePath, [
    'BEGIN IMMEDIATE;',
    ...Array.from(deletedNames).map((name) => `DELETE FROM vwd_documents WHERE name=${sqlText(name)};`),
    ...preparedDocuments.flatMap((document) => documentWriteSql(document, false)),
    libraryRowSql(updated),
    'COMMIT;'
  ].join('\n'));
  return {
    status: 200,
    revisions,
    deletedDocuments: Array.from(deletedNames)
  };
}

function getLibraryInfo(filePath) {
  const library = readLibraryRow(filePath);
  const rows = query(filePath, 'SELECT COUNT(*) AS document_count FROM vwd_documents;');
  return {
    libraryId: library.libraryId,
    documentCount: Number(rows[0] && rows[0].document_count) || 0,
    updatedAt: library.updatedAt
  };
}

module.exports = {
  LIBRARY_KIND,
  SQLITE_SCHEMA_VERSION,
  DOCUMENT_CHUNK_SIZE,
  DOCUMENT_CHUNK_THRESHOLD,
  ensureSchema,
  getRuntimeInfo,
  getLibraryInfo,
  isLibraryFile,
  patchLibraryState,
  readLibrary,
  readLibrarySummary,
  readWaveDocument,
  updateWaveDocument,
  writeLibrary
};
