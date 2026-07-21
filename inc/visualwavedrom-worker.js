'use strict';

function flattenSignalMetrics(signals, metrics) {
  if (!Array.isArray(signals)) return;
  for (let i = 0; i < signals.length; i += 1) {
    const signal = signals[i];
    if (Array.isArray(signal)) {
      metrics.groupCount += 1;
      flattenSignalMetrics(signal.slice(1), metrics);
      continue;
    }
    if (!signal || typeof signal !== 'object') continue;
    metrics.signalCount += 1;
    const waveLength = typeof signal.wave === 'string' ? signal.wave.length : 0;
    if (waveLength > metrics.maxWaveLength) metrics.maxWaveLength = waveLength;
    metrics.cellCount += waveLength;
  }
}

function analyzeDocument(text) {
  const source = JSON.parse(text);
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('JSON 根节点必须是对象');
  }
  const metrics = {
    signalCount: 0,
    groupCount: 0,
    maxWaveLength: 0,
    cellCount: 0,
    edgeCount: Array.isArray(source.edge) ? source.edge.length : 0
  };
  flattenSignalMetrics(source.signal, metrics);
  const title = typeof source.title === 'string'
    ? source.title.trim()
    : (source.head && typeof source.head.text === 'string' ? source.head.text.trim() : '');
  const description = typeof source.description === 'string' ? source.description : '';
  return { source, metrics, title, description };
}

self.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.type !== 'analyze-document') return;
  try {
    const result = analyzeDocument(String(message.text == null ? '' : message.text));
    self.postMessage({
      id: message.id,
      ok: true,
      source: result.source,
      metrics: result.metrics,
      title: result.title,
      description: result.description
    });
  } catch (error) {
    self.postMessage({
      id: message.id,
      ok: false,
      error: error && error.message ? error.message : String(error)
    });
  }
});
