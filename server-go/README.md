# VisualWaveDrom static server

This directory contains the dependency-free service-mode launcher source.

- HTTP and library APIs are implemented in Go.
- SQLite is embedded through the CGo-free `modernc.org/sqlite` driver.
- Release binaries are built with `CGO_ENABLED=0`.
- The Linux x64 build does not require Node.js, sqlite3, glibc, or an installer.

Build both release programs from the project root:

```powershell
powershell -ExecutionPolicy Bypass -File tools/BuildGoServer.ps1
```

Set `VWD_GO_EXE` when Go is not on `PATH`. The generated files and their
SHA-256 checksums are written to `bin`.
