Portable Node.js runtime files are installed in this directory automatically.

Run VisualWaveDrom.bat on an Internet-connected computer and accept the download
prompt. Keep this directory when copying VisualWaveDrom for offline use.

The downloaded runtime is excluded from Git because it is large and platform-specific.

On Linux, VisualWaveDrom.sh first checks inc/node-runtime/bin/node and
inc/node-runtime/node, then falls back to node or nodejs from PATH. A custom
runtime can be selected with VWD_NODE_EXE. Linux runtime files are not
downloaded automatically because their package format depends on the target
distribution, CPU architecture, and C library.
