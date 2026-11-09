'use strict';

importScripts('visualwavedrom-bigdata.js?v=sparse-import-v1');

function analyzeDocument(text) {
  const source = JSON.parse(text);
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('JSON 根节点必须是对象');
  }
  const metrics = self.VisualWaveDromBigData.measureSource(source);
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
