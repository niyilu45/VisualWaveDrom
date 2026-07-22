(function (global) {
  'use strict';

  const LIBRARY_KIND = 'VisualWaveDromWaveLibrary';
  const SNAPSHOT_DB_NAME = 'VisualWaveDromSQLite';
  const SNAPSHOT_STORE_NAME = 'waveLibraries';
  const SNAPSHOT_KEY = 'active:' + encodeURIComponent(global.location.pathname || 'VisualWaveDrom.html');
  const SQLITE_HEADER = 'SQLite format 3\0';
  const moduleBaseUrl = new URL('.', document.currentScript.src).href;
  let sqlitePromise = null;

  const schemaSql = `
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
    PRAGMA user_version=1;
  `;

  function loadScript(relativePath) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL(relativePath, moduleBaseUrl).href;
      script.onload = resolve;
      script.onerror = () => reject(new Error('无法加载 SQLite 运行文件: ' + relativePath));
      document.head.appendChild(script);
    });
  }

  function decodeBase64(value) {
    const binary = global.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function loadSqlite() {
    if (sqlitePromise) return sqlitePromise;
    sqlitePromise = (async () => {
      if (!global.VWD_SQLITE_WASM_BASE64) await loadScript('sqlite/sqlite3-wasm-data.js');
      if (typeof global.sqlite3InitModule !== 'function') await loadScript('sqlite/sqlite3.js');
      const wasmBinary = decodeBase64(global.VWD_SQLITE_WASM_BASE64 || '');
      const sqlite3 = await global.sqlite3InitModule({
        wasmBinary,
        instantiateWasm(imports, receiveInstance) {
          WebAssembly.instantiate(wasmBinary, imports).then((result) => {
            receiveInstance(result.instance, result.module);
          });
          return {};
        }
      });
      global.VWD_SQLITE_WASM_BASE64 = '';
      return sqlite3;
    })();
    return sqlitePromise;
  }

  function openSnapshotDatabase() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error('当前浏览器不支持 IndexedDB'));
        return;
      }
      const request = global.indexedDB.open(SNAPSHOT_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SNAPSHOT_STORE_NAME)) {
          database.createObjectStore(SNAPSHOT_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开浏览器数据库'));
    });
  }

  function readSnapshot(database) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(SNAPSHOT_STORE_NAME, 'readonly');
      const request = transaction.objectStore(SNAPSHOT_STORE_NAME).get(SNAPSHOT_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('无法读取浏览器数据库'));
    });
  }

  function writeSnapshot(database, record) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(SNAPSHOT_STORE_NAME, 'readwrite');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('无法保存浏览器数据库'));
      transaction.objectStore(SNAPSHOT_STORE_NAME).put(record);
    });
  }

  function parseJson(value, fallback) {
    try {
      return JSON.parse(String(value == null ? '' : value));
    } catch (_) {
      return fallback;
    }
  }

  function newLibraryId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return 'library-' + global.crypto.randomUUID();
    }
    return 'library-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function documentMetadata(content, fallbackName) {
    const source = JSON.parse(String(content));
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('波形 JSON 根节点必须是对象');
    }
    const title = typeof source.title === 'string' ? source.title.trim() : '';
    const head = source.head && typeof source.head.text === 'string' ? source.head.text.trim() : '';
    return {
      titleCache: title || head || fallbackName || '',
      descriptionCache: typeof source.description === 'string' ? source.description : ''
    };
  }

  const knownDocumentFields = new Set([
    'name', 'content', 'json', 'hscale', 'waveEditMode', 'revision', 'savedAt',
    'deferred', 'titleCache', 'descriptionCache', 'contentLength', 'sortOrder'
  ]);

  function prepareDocument(document, sortOrder) {
    if (!document || typeof document.name !== 'string' || typeof document.content !== 'string') {
      throw new Error('波形图数据无效');
    }
    const name = document.name.trim();
    if (!name) throw new Error('波形图标识不能为空');
    const metadata = documentMetadata(document.content, name);
    const extra = {};
    Object.keys(document).forEach((key) => {
      if (!knownDocumentFields.has(key) && document[key] !== undefined) extra[key] = document[key];
    });
    return {
      name,
      sortOrder: Number.isInteger(sortOrder) ? sortOrder : Number(document.sortOrder || 0),
      content: document.content,
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

  function normalizeBundle(bundle) {
    if (!bundle || bundle.kind !== LIBRARY_KIND || !Array.isArray(bundle.documents)) {
      throw new Error('波形库文件格式无效');
    }
    return {
      kind: LIBRARY_KIND,
      version: Math.max(2, Number(bundle.version) || 2),
      libraryId: String(bundle.libraryId || newLibraryId()),
      updatedAt: typeof bundle.updatedAt === 'string' ? bundle.updatedAt : new Date().toISOString(),
      directories: Array.isArray(bundle.directories) ? bundle.directories : [],
      rootDocuments: Array.isArray(bundle.rootDocuments) ? bundle.rootDocuments : [],
      activeDocumentName: typeof bundle.activeDocumentName === 'string' ? bundle.activeDocumentName : '',
      selectedDirectoryId: typeof bundle.selectedDirectoryId === 'string' ? bundle.selectedDirectoryId : 'nav-root',
      documents: bundle.documents.map((document, index) => prepareDocument(document, index))
    };
  }

  class BrowserWaveLibraryStore {
    constructor(sqlite3, snapshotDatabase) {
      this.sqlite3 = sqlite3;
      this.snapshotDatabase = snapshotDatabase;
      this.db = null;
      this.fileName = 'VisualWaveDrom-library.sqlite';
      this.openEmpty();
    }

    uniquePath() {
      return '/vwd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '.sqlite';
    }

    openEmpty() {
      if (this.db) this.db.close();
      this.db = new this.sqlite3.oo1.DB(this.uniquePath(), 'ct');
      this.db.exec(schemaSql);
    }

    query(sql, bind) {
      const rows = [];
      this.db.exec({
        sql,
        bind: bind || undefined,
        rowMode: 'object',
        callback: (row) => rows.push(row)
      });
      return rows;
    }

    transaction(callback) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch (_) { /* keep the original error */ }
        throw error;
      }
    }

    validate() {
      const row = this.query('SELECT kind, library_id FROM vwd_library WHERE singleton=1 LIMIT 1')[0];
      if (!row || row.kind !== LIBRARY_KIND || !row.library_id) {
        throw new Error('不是有效的 VisualWaveDrom SQLite 波形库');
      }
    }

    libraryRow() {
      const row = this.query(`SELECT kind, version, library_id, updated_at, directories_json,
        root_documents_json, active_document_name, selected_directory_id
        FROM vwd_library WHERE singleton=1 LIMIT 1`)[0];
      if (!row || row.kind !== LIBRARY_KIND) throw new Error('SQLite 波形库缺少库信息');
      return {
        kind: LIBRARY_KIND,
        version: Math.max(2, Number(row.version) || 2),
        libraryId: String(row.library_id || ''),
        updatedAt: String(row.updated_at || ''),
        directories: parseJson(row.directories_json, []),
        rootDocuments: parseJson(row.root_documents_json, []),
        activeDocumentName: String(row.active_document_name || ''),
        selectedDirectoryId: String(row.selected_directory_id || 'nav-root')
      };
    }

    writeLibraryRow(library) {
      this.db.exec({
        sql: `INSERT INTO vwd_library (
          singleton, kind, version, library_id, updated_at, directories_json,
          root_documents_json, active_document_name, selected_directory_id
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          kind=excluded.kind, version=excluded.version, library_id=excluded.library_id,
          updated_at=excluded.updated_at, directories_json=excluded.directories_json,
          root_documents_json=excluded.root_documents_json,
          active_document_name=excluded.active_document_name,
          selected_directory_id=excluded.selected_directory_id`,
        bind: [
          library.kind, library.version, library.libraryId, library.updatedAt,
          JSON.stringify(library.directories), JSON.stringify(library.rootDocuments),
          library.activeDocumentName, library.selectedDirectoryId
        ]
      });
    }

    writeDocument(document) {
      this.db.exec({
        sql: `INSERT INTO vwd_documents (
          name, sort_order, content, hscale, wave_edit_mode, revision, saved_at,
          title_cache, description_cache, content_length, extra_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          sort_order=excluded.sort_order, content=excluded.content, hscale=excluded.hscale,
          wave_edit_mode=excluded.wave_edit_mode, revision=excluded.revision,
          saved_at=excluded.saved_at, title_cache=excluded.title_cache,
          description_cache=excluded.description_cache, content_length=excluded.content_length,
          extra_json=excluded.extra_json`,
        bind: [
          document.name, document.sortOrder, document.content, document.hscale,
          document.waveEditMode, document.revision, document.savedAt, document.titleCache,
          document.descriptionCache, document.contentLength, document.extraJson
        ]
      });
    }

    writeBundle(bundle) {
      const library = normalizeBundle(bundle);
      this.transaction(() => {
        this.db.exec('DELETE FROM vwd_documents; DELETE FROM vwd_library;');
        this.writeLibraryRow(library);
        library.documents.forEach((document) => this.writeDocument(document));
      });
      return this.readSummary();
    }

    documentFromRow(row, summaryOnly) {
      const document = Object.assign({}, parseJson(row.extra_json, {}), {
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
        document.content = String(row.content || '');
      }
      return document;
    }

    readSummary() {
      const library = this.libraryRow();
      library.documents = this.query(`SELECT name, hscale, wave_edit_mode, revision, saved_at,
        title_cache, description_cache, content_length, extra_json
        FROM vwd_documents ORDER BY sort_order, name`).map((row) => this.documentFromRow(row, true));
      return library;
    }

    readBundle() {
      const library = this.libraryRow();
      library.documents = this.query(`SELECT name, content, hscale, wave_edit_mode, revision, saved_at,
        title_cache, description_cache, content_length, extra_json
        FROM vwd_documents ORDER BY sort_order, name`).map((row) => this.documentFromRow(row, false));
      return library;
    }

    readDocument(name) {
      const row = this.query(`SELECT name, content, hscale, wave_edit_mode, revision, saved_at,
        title_cache, description_cache, content_length, extra_json
        FROM vwd_documents WHERE name=? LIMIT 1`, [String(name || '')])[0];
      return row ? this.documentFromRow(row, false) : null;
    }

    patchState(payload) {
      const library = this.libraryRow();
      const deletedNames = new Set(Array.isArray(payload.deletedDocuments)
        ? payload.deletedDocuments.map((name) => String(name || '')).filter(Boolean)
        : []);
      const incomingDocuments = Array.isArray(payload.documents) ? payload.documents : [];
      const preparedDocuments = [];
      const revisions = [];
      const nextRow = this.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM vwd_documents')[0];
      let nextSortOrder = Number(nextRow && nextRow.next_order) || 0;

      incomingDocuments.forEach((incoming) => {
        const name = incoming && String(incoming.name || '').trim();
        if (!name || typeof incoming.content !== 'string') throw new Error('波形图数据无效');
        const previous = this.readDocument(name);
        const expectedRevision = Number(incoming.revision);
        if (previous && Number.isInteger(expectedRevision) && expectedRevision !== previous.revision) {
          const sameState = incoming.content === previous.content
            && Number(incoming.hscale) === Number(previous.hscale)
            && incoming.waveEditMode === previous.waveEditMode;
          if (!sameState) throw new Error('波形图版本冲突: ' + name);
          revisions.push({ name, revision: previous.revision, savedAt: previous.savedAt });
          return;
        }
        const sortRow = previous
          ? this.query('SELECT sort_order FROM vwd_documents WHERE name=? LIMIT 1', [name])[0]
          : null;
        const savedAt = new Date().toISOString();
        const document = prepareDocument(Object.assign({}, previous || {}, incoming, {
          name,
          revision: previous ? previous.revision + 1 : 0,
          savedAt
        }), sortRow ? Number(sortRow.sort_order) : nextSortOrder++);
        preparedDocuments.push(document);
        revisions.push({ name, revision: document.revision, savedAt });
      });

      const updated = Object.assign({}, library, {
        directories: Array.isArray(payload.directories) ? payload.directories : library.directories,
        rootDocuments: Array.isArray(payload.rootDocuments) ? payload.rootDocuments : library.rootDocuments,
        activeDocumentName: typeof payload.activeDocumentName === 'string'
          ? payload.activeDocumentName : library.activeDocumentName,
        selectedDirectoryId: typeof payload.selectedDirectoryId === 'string'
          ? payload.selectedDirectoryId : library.selectedDirectoryId,
        updatedAt: new Date().toISOString()
      });
      this.transaction(() => {
        deletedNames.forEach((name) => {
          this.db.exec({ sql: 'DELETE FROM vwd_documents WHERE name=?', bind: [name] });
        });
        preparedDocuments.forEach((document) => this.writeDocument(document));
        this.writeLibraryRow(updated);
      });
      return { revisions, deletedDocuments: Array.from(deletedNames) };
    }

    exportBytes() {
      return this.sqlite3.capi.sqlite3_js_db_export(this.db.pointer);
    }

    async importBytes(bytes, fileName) {
      let data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
      let header = '';
      for (let index = 0; index < Math.min(SQLITE_HEADER.length, data.length); index += 1) {
        header += String.fromCharCode(data[index]);
      }
      if (header !== SQLITE_HEADER) throw new Error('所选文件不是 SQLite 波形库');
      // Older service builds used WAL mode. A standalone main database has no
      // companion -wal file, and the browser VFS cannot open its WAL header.
      // Service writes checkpointed every transaction, so switching the copied
      // header back to the portable rollback-journal format preserves its data.
      if (data.length > 19 && (data[18] === 2 || data[19] === 2)) {
        data = data.slice();
        data[18] = 1;
        data[19] = 1;
      }
      const filePath = this.uniquePath();
      this.sqlite3.capi.sqlite3_js_posix_create_file(filePath, data);
      const imported = new this.sqlite3.oo1.DB(filePath, 'w');
      const previous = this.db;
      this.db = imported;
      try {
        this.db.exec('PRAGMA journal_mode=DELETE');
        this.validate();
      } catch (error) {
        this.db = previous;
        imported.close();
        throw error;
      }
      if (previous) previous.close();
      this.fileName = String(fileName || this.fileName || 'VisualWaveDrom-library.sqlite');
      return this.readSummary();
    }

    async loadPersisted() {
      const record = await readSnapshot(this.snapshotDatabase);
      if (!record || !record.bytes) return false;
      await this.importBytes(new Uint8Array(record.bytes), record.fileName);
      return true;
    }

    persist() {
      const bytes = this.exportBytes();
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const record = {
        id: SNAPSHOT_KEY,
        fileName: this.fileName,
        bytes: copy,
        updatedAt: new Date().toISOString()
      };
      return writeSnapshot(this.snapshotDatabase, record);
    }
  }

  global.VWDSqliteLibrary = {
    kind: LIBRARY_KIND,
    async createStore() {
      const results = await Promise.all([loadSqlite(), openSnapshotDatabase()]);
      return new BrowserWaveLibraryStore(results[0], results[1]);
    }
  };
})(window);
