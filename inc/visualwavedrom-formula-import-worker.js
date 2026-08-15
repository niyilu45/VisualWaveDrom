(function (global) {
'use strict';

if (!global.VisualWaveDromFormula && typeof global.importScripts === 'function') {
  global.importScripts('visualwavedrom-formula.js?v=20260815-large-import-v1');
}

function analysisSummary(analysis) {
  return {
    items: analysis && Array.isArray(analysis.items)
      ? analysis.items.map((item) => ({
        id: item.id,
        name: item.name,
        valid: !!item.valid,
        error: String(item.error || '')
      }))
      : []
  };
}

global.addEventListener('message', async (event) => {
  const request = event.data || {};
  const requestId = request.requestId;
  if (request.type !== 'build-formula-updates') return;
  try {
    const engine = global.VisualWaveDromFormula;
    if (!engine || typeof engine.buildFormulaUpdates !== 'function') {
      throw new Error('公式模块未加载');
    }
    const definitions = Array.isArray(request.definitions) ? request.definitions : [];
    const firstDefinition = definitions[0] || {};
    global.postMessage({
      requestId,
      type: 'progress',
      progress: {
        phase: 'formula',
        stage: 'preparing',
        index: 0,
        total: definitions.length,
        name: String(firstDefinition.name || '')
      }
    });
    const sendProgress = (stage) => (details) => {
      global.postMessage({
        requestId,
        type: 'progress',
        progress: Object.assign({ phase: 'formula', stage }, details || {})
      });
    };
    const build = typeof engine.buildFormulaUpdatesAsync === 'function'
      ? engine.buildFormulaUpdatesAsync.bind(engine)
      : engine.buildFormulaUpdates.bind(engine);
    const built = await build(
      request.documentValue,
      request.importedUpdates,
      definitions,
      {
        parallel: true,
        totalColumns: request.totalColumns,
        workerUrl: 'visualwavedrom-formula-eval-worker.js?v=20260815-large-import-v1',
        onFormulaStart: sendProgress('evaluating'),
        onFormulaComplete: sendProgress('evaluated'),
        onFormulaPackageStart: sendProgress('packaging'),
        onLayerStart: sendProgress('layer')
      }
    );
    global.postMessage({
      requestId,
      type: 'complete',
      result: {
        updates: built.updates,
        analysis: analysisSummary(built.analysis),
        totalColumns: built.totalColumns,
        allUnknown: built.allUnknown,
        sourceKinds: built.sourceKinds,
        cacheStats: built.cacheStats,
        layers: built.layers,
        parallelWorkerCount: built.parallelWorkerCount,
        evaluationDurationMs: built.evaluationDurationMs
      }
    });
  } catch (error) {
    global.postMessage({
      requestId,
      type: 'error',
      error: error && error.message ? error.message : String(error)
    });
  }
});
})(self);
