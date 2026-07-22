# SQLite runtime

This directory vendors the official SQLite 3.53.3 WebAssembly and Windows CLI builds.

- Source: https://www.sqlite.org/download.html
- `sqlite3.js` and the embedded WASM bytes come from `sqlite-wasm-3530300.zip`.
- `sqlite3.exe` comes from `sqlite-tools-win-x64-3530300.zip`.
- SQLite is in the public domain: https://www.sqlite.org/copyright.html

The embedded WASM form keeps direct `file://` use working in Chrome and Edge without fetching a local `.wasm` file.
