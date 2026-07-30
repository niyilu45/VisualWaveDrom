# SQLite runtime

This directory vendors the official SQLite 3.53.3 WebAssembly build used when
`VisualWaveDrom.html` is opened directly.

- Source: https://www.sqlite.org/download.html
- `sqlite3.js` and the embedded WASM bytes come from `sqlite-wasm-3530300.zip`.
- SQLite is in the public domain: https://www.sqlite.org/copyright.html

The embedded WASM form keeps direct `file://` use working in Chrome and Edge without fetching a local `.wasm` file.

VisualWaveDrom schema version 2 stores JSON documents below 256 KiB inline and larger
documents in ordered 64 KiB rows in `vwd_document_chunks`. Both layouts remain inside the
same `.sqlite` file. The browser-WASM adapter and static Go service create the
tables automatically when an older library is opened.

Service mode embeds SQLite in the Windows and Linux programs under `bin`.
It does not use an external `sqlite3` executable.
