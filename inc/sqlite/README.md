# SQLite runtime

This directory vendors the official SQLite 3.53.3 WebAssembly and Windows CLI builds.

- Source: https://www.sqlite.org/download.html
- `sqlite3.js` and the embedded WASM bytes come from `sqlite-wasm-3530300.zip`.
- `sqlite3.exe` comes from `sqlite-tools-win-x64-3530300.zip`.
- SQLite is in the public domain: https://www.sqlite.org/copyright.html

The embedded WASM form keeps direct `file://` use working in Chrome and Edge without fetching a local `.wasm` file.

VisualWaveDrom schema version 2 stores JSON documents below 256 KiB inline and larger
documents in ordered 64 KiB rows in `vwd_document_chunks`. Both layouts remain inside the
same `.sqlite` file. The Node and browser-WASM adapters create the table automatically when
an older library is opened.

Linux service mode uses SQLite 3.33 or newer from one of these locations:

1. `VWD_SQLITE_EXE`
2. `inc/sqlite/sqlite3` when an executable compatible with the target Linux system is supplied
3. `sqlite3` from `PATH`

`VisualWaveDrom.sh --check-runtime` validates the selected executable and its JSON output mode.
The repository does not vendor one Linux binary because Linux executables depend on the target
distribution, CPU architecture, and C library.
