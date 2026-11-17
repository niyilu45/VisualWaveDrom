(function (root) {
  'use strict';

  function create() {
    const owner = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
    let server = /^https?:$/.test(location.protocol);
    let database;
    let nextId = 0;

    function openDatabase() {
      if (!database) database = new Promise((resolve, reject) => {
        const request = indexedDB.open('visualwavedrom-undo-archive', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return database;
    }

    async function queryBrowser(mode, run) {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('snapshots', mode);
        const request = run(transaction.objectStore('snapshots'));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onabort = transaction.onerror = () => reject(transaction.error);
      });
    }

    const address = (action, id, limit) => '/api/undo-history?' + new URLSearchParams({ action, owner, id, limit });
    const key = id => owner + ':' + id;
    function request(action, id, limit, body, keepalive) {
      return fetch(address(action, id, limit), { method: 'POST', cache: 'no-store',
        headers: { 'X-VWD-Undo': '1' }, body, keepalive });
    }

    async function pack(content) {
      const raw = new Blob([typeof content === 'string' ? content : JSON.stringify(content)]);
      if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') return { blob: raw, gzip: false };
      const gzip = await new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      return gzip.size < raw.size ? { blob: gzip, gzip: true } : { blob: raw, gzip: false };
    }

    async function write(content, limit, remaining) {
      const id = ++nextId;
      const { blob, gzip } = await pack(content);
      if (blob.size > remaining()) return null;
      if (server) {
        const response = await request('write', id, limit, blob);
        if (response.ok) return { id, gzip, text: typeof content === 'string', bytes: blob.size, server: true };
        if (response.status === 507 || response.status === 413) return null;
        if (response.status !== 404) throw new Error('SQLite undo archive: ' + response.status);
        server = false;
      }
      await queryBrowser('readwrite', store => store.put(blob, key(id)));
      return { id, gzip, text: typeof content === 'string', bytes: blob.size, server: false };
    }

    async function read(record) {
      let blob;
      if (record.server) {
        const response = await request('read', record.id);
        if (!response.ok) throw new Error('undo archive: ' + response.status);
        blob = await response.blob();
      } else blob = await queryBrowser('readonly', store => store.get(key(record.id)));
      if (!blob) throw new Error('undo snapshot missing');
      const text = record.gzip
        ? await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text()
        : await blob.text();
      return record.text ? text : JSON.parse(text);
    }

    function remove(record) {
      return record.server ? request('delete', record.id) : queryBrowser('readwrite', store => store.delete(key(record.id)));
    }

    function clear() {
      if (server) void request('clear', '', '', undefined, true).catch(() => {});
      if (database) void queryBrowser('readwrite', store => store.delete(IDBKeyRange.bound(owner + ':', owner + ';'))).catch(() => {});
    }

    root.addEventListener('pagehide', clear);
    return { write, read, remove };
  }

  root.VisualWaveDromUndoArchive = { create };
}(window));
