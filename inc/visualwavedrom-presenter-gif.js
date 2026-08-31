(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VisualWaveDromPresenterGif = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const MAX_FRAMES = 200;
  const MAX_PIXELS = 4000000;
  const MAX_DIMENSION = 4096;
  const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
  const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

  function cancelled() {
    const error = new Error('gif-cancelled');
    error.name = 'AbortError';
    return error;
  }

  function checkSignal(signal) {
    if (signal && signal.aborted) throw cancelled();
  }

  function validate(count, delay) {
    if (!Number.isInteger(count) || count < 2) throw new Error('gif-steps-required');
    if (count > MAX_FRAMES) throw new Error('gif-too-many-steps');
    if (!Number.isFinite(delay) || delay < 100 || delay > 60000) throw new Error('gif-invalid-delay');
  }

  function frameLayout(frames) {
    let width = 0, height = 0;
    frames.forEach(frame => {
      if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width <= 0 || frame.height <= 0) {
        throw new Error('missing-waveform');
      }
      width = Math.max(width, frame.width);
      height = Math.max(height, frame.height);
    });
    if (!width || !height) throw new Error('missing-waveform');
    const scale = Math.min(2, MAX_DIMENSION / width, MAX_DIMENSION / height, Math.sqrt(MAX_PIXELS / (width * height)));
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
  }

  // This function and the library factory are self-contained so Blob workers also work from file://.
  function createCodec(createLibrary) {
    const api = createLibrary();
    const encoder = api.GIFEncoder();
    return {
      write(data, width, height, delay) {
        const palette = api.quantize(data, 256);
        const index = api.applyPalette(data, palette);
        encoder.writeFrame(index, width, height, { palette, delay, repeat: 0, dispose: 1 });
        if (encoder.bytesView().byteLength > 64 * 1024 * 1024) throw new Error('gif-output-too-large');
      },
      finish() {
        encoder.finish();
        return encoder.bytes();
      }
    };
  }

  function encoderWorker(makeCodec, createLibrary) {
    let codec;
    self.onmessage = event => {
      try {
        const request = event.data;
        if (request.type === 'init') {
          codec = makeCodec(createLibrary);
          self.postMessage({ type: 'ready' });
        } else if (request.type === 'frame') {
          codec.write(new Uint8ClampedArray(request.data), request.width, request.height, request.delay);
          self.postMessage({ type: 'frame' });
        } else if (request.type === 'finish') {
          const bytes = codec.finish();
          self.postMessage({ type: 'finished', bytes: bytes.buffer }, [bytes.buffer]);
          codec = null;
        }
      } catch (error) {
        self.postMessage({ type: 'error', message: error.message });
      }
    };
  }

  async function createSession(signal) {
    checkSignal(signal);
    const factory = root.VisualWaveDromGifencFactory;
    if (typeof factory !== 'function') throw new Error('gif-module-missing');
    let worker, workerUrl, pending, startupTimer;
    const rejectPending = error => {
      if (!pending) return;
      const reject = pending.reject;
      pending = null;
      reject(error);
    };
    const dispose = () => {
      clearTimeout(startupTimer);
      rejectPending(cancelled());
      if (worker) worker.terminate();
      worker = null;
      if (workerUrl) root.URL.revokeObjectURL(workerUrl);
      workerUrl = null;
      if (signal) signal.removeEventListener('abort', dispose);
    };
    const send = (message, transfer) => new Promise((resolve, reject) => {
      try {
        checkSignal(signal);
        pending = { resolve, reject };
        worker.postMessage(message, transfer || []);
      } catch (error) { pending = null; reject(error); }
    });
    if (typeof root.Worker === 'function') {
      try {
        const source = '(' + encoderWorker.toString() + ')(' + createCodec.toString() + ',' + factory.toString() + ');';
        workerUrl = root.URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        worker = new root.Worker(workerUrl);
        worker.onmessage = event => {
          if (!pending) return;
          if (event.data.type === 'error') rejectPending(new Error(event.data.message));
          else {
            const resolve = pending.resolve;
            pending = null;
            resolve(event.data);
          }
        };
        worker.onerror = event => {
          event.preventDefault();
          rejectPending(new Error('gif-worker-failed'));
        };
        if (signal) signal.addEventListener('abort', dispose, { once: true });
        startupTimer = setTimeout(() => rejectPending(new Error('gif-worker-timeout')), 3000);
        await send({ type: 'init' });
        clearTimeout(startupTimer);
        return {
          write: (data, width, height, delay) => send({ type: 'frame', data: data.buffer, width, height, delay }, [data.buffer]),
          finish: async () => new Uint8Array((await send({ type: 'finish' })).bytes),
          dispose
        };
      } catch (_error) {
        dispose();
        checkSignal(signal);
      }
    }
    const codec = createCodec(factory);
    return { write: (data, width, height, delay) => codec.write(data, width, height, delay), finish: () => codec.finish(), dispose() {} };
  }

  async function encodeFrames(options) {
    const { count, width, height, delay, getFrame, signal } = options;
    validate(count, delay);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error('image-too-large');
    const session = await createSession(signal);
    try {
      for (let index = 0; index < count; index++) {
        await nextTurn();
        checkSignal(signal);
        const data = await getFrame(index);
        checkSignal(signal);
        if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4 || data.byteOffset !== 0
            || data.byteLength !== data.buffer.byteLength) throw new Error('gif-invalid-frame');
        await session.write(data, width, height, delay);
        checkSignal(signal);
        if (options.onFrame) options.onFrame(index + 1);
      }
      const bytes = await session.finish();
      checkSignal(signal);
      return new Blob([bytes], { type: 'image/gif' });
    } finally { session.dispose(); }
  }

  function rasterize(frame, canvas, layout, signal) {
    checkSignal(signal);
    return new Promise((resolve, reject) => {
      const url = root.URL.createObjectURL(new Blob([frame.source], { type: 'image/svg+xml;charset=utf-8' }));
      const image = new root.Image();
      let settled = false;
      const cleanup = () => {
        image.onload = image.onerror = null;
        root.URL.revokeObjectURL(url);
        if (signal) signal.removeEventListener('abort', abort);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        image.src = '';
        reject(error);
      };
      const abort = () => fail(cancelled());
      image.onload = () => {
        if (settled) return;
        try {
          checkSignal(signal);
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('gif-canvas-unavailable');
          context.fillStyle = '#fff';
          context.fillRect(0, 0, layout.width, layout.height);
          context.drawImage(image, 0, 0, frame.width * layout.scale, frame.height * layout.scale);
          const data = context.getImageData(0, 0, layout.width, layout.height).data;
          settled = true;
          cleanup();
          resolve(data);
        } catch (error) { fail(error); }
      };
      image.onerror = () => fail(new Error('gif-image-load-failed'));
      if (signal) signal.addEventListener('abort', abort, { once: true });
      if (signal && signal.aborted) abort();
      else image.src = url;
    });
  }

  async function generate(options) {
    const { count, delay, renderFrame, signal } = options;
    validate(count, delay);
    checkSignal(signal);
    const frames = [];
    let sourceBytes = 0;
    const progress = (phase, index, completed) => {
      if (options.onProgress) options.onProgress({ phase, index, count, completed, total: count * 2 });
    };
    let canvas;
    try {
      // Retain bounded SVG snapshots, never a full animation's uncompressed pixel buffers.
      for (let index = 0; index < count; index++) {
        progress('prepare', index, index);
        await nextTurn();
        checkSignal(signal);
        const result = await renderFrame(index);
        checkSignal(signal);
        const source = new root.XMLSerializer().serializeToString(result.svg);
        sourceBytes += source.length * 2;
        if (sourceBytes > MAX_SOURCE_BYTES) throw new Error('gif-source-too-large');
        frames.push({ source, width: result.metrics.width, height: result.metrics.height });
      }
      const layout = frameLayout(frames);
      canvas = root.document.createElement('canvas');
      canvas.width = layout.width;
      canvas.height = layout.height;
      const blob = await encodeFrames({
        count, delay, width: layout.width, height: layout.height, signal,
        getFrame: async index => {
          progress('encode', index, count + index);
          const frame = frames[index];
          const pixels = await rasterize(frame, canvas, layout, signal);
          frames[index] = null;
          return pixels;
        },
        onFrame: done => progress('encode', done - 1, count + done)
      });
      return { blob, width: layout.width, height: layout.height, count, delay };
    } finally {
      frames.length = 0;
      if (canvas) canvas.width = canvas.height = 1;
    }
  }

  return { generate, encodeFrames, frameLayout, maxFrames: MAX_FRAMES };
}));
