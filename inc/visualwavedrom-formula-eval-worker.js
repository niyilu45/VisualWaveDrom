(function (global) {
'use strict';

if (!global.VisualWaveDromFormula && typeof global.importScripts === 'function') {
  global.importScripts('visualwavedrom-formula.js?v=20260815-large-import-v1');
}

let sources = Object.create(null);

function response(requestId, ok, result, error) {
  global.postMessage({
    requestId,
    ok,
    result: result || null,
    error: error || ''
  });
}

global.addEventListener('message', (event) => {
  const request = event.data || {};
  const requestId = request.requestId;
  try {
    if (request.type === 'reset') {
      sources = Object.assign(Object.create(null), request.sources || {});
      response(requestId, true, { sourceCount: Object.keys(sources).length });
      return;
    }
    if (request.type === 'update') {
      Object.assign(sources, request.sources || {});
      response(requestId, true, { sourceCount: Object.keys(sources).length });
      return;
    }
    if (request.type !== 'evaluate') return;
    const engine = global.VisualWaveDromFormula;
    if (!engine) throw new Error('Formula engine is unavailable');
    const definition = request.definition || {};
    const name = String(definition.name || '');
    const evaluated = engine.evaluateDefinitions(
      [definition],
      Array.isArray(request.signalNames) ? request.signalNames : Object.keys(sources),
      {
        sources,
        sourceIsConsumerIndependent: true,
        totalColumns: request.totalColumns,
        chunkSize: request.chunkSize
      }
    );
    response(requestId, true, {
      values: evaluated.outputs[name] || [],
      knownCount: Number(evaluated.knownCounts[name] || 0),
      evaluationMode: evaluated.evaluationModes[name] || 'scalar'
    });
  } catch (error) {
    response(requestId, false, null, error && error.message ? error.message : String(error));
  }
});
})(self);
