'use strict';
// CLI AGENT APIS — CLI parity for the agent APIs the desktop wires in
// main.cjs (project rule: every agent improvement ships to BOTH surfaces).
// Provider-GENERIC by construction: everything runs against the connection
// the CLI was started with (its own baseUrl + key). No provider names here.
//
//   createCliModelTaskApi — image/tts/stt/video generation + editing
//     (imagePath: the HARNESS reads and attaches the file, never the model
//     context; saveTo: the result lands on disk as a real file).
//   createCliCatalogApi — the model_catalog backend: live /models discovery
//     on the CLI's connection, two-mode response (summary / filtered), and
//     the deliberate narrow live-capability probe (probe:true).

const fs = require('fs');
const path = require('path');
const { runModelTask, inferModelKind, MODEL_KINDS } = require('../desktop/agent/mediaRouter.cjs');
const { compactModelEntry, catalogResponse } = require('../desktop/agent/modelCatalog.cjs');
const { probeModelsForCapability, loadProbeCache } = require('../desktop/agent/modelCapabilityProbe.cjs');

const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url || ''); } };

function createCliModelTaskApi({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch, timeoutMs = 180_000, onNote = null, outDir = null } = {}) {
  return async (request = {}) => {
    const wantedKind = MODEL_KINDS.includes(request?.kind) ? request.kind : 'image';
    // imagePath: the harness reads and attaches the local file — zero bytes
    // through the model context (the fileBase64 transit burned a whole run
    // on the desktop before this existed; see run-forensics 2026-10-15).
    let imageBase64 = null;
    let imageFilename = null;
    if (wantedKind === 'image' && String(request.imagePath || '').trim()) {
      const source = path.resolve(String(request.imagePath).trim());
      const stat = fs.statSync(source);
      if (!stat.isFile()) throw new Error(`imagePath is not a file: ${source}`);
      if (stat.size > 10 * 1024 * 1024) throw new Error(`imagePath exceeds the 10MB edit budget (${stat.size} bytes).`);
      if (!/\.(png|jpe?g|webp|gif)$/i.test(source)) throw new Error('imagePath must be a png/jpg/webp/gif file.');
      imageBase64 = fs.readFileSync(source).toString('base64');
      imageFilename = path.basename(source);
    }
    const outcome = await runModelTask({
      baseUrl: String(baseUrl || '').replace(/\/$/, ''),
      apiKey,
      kind: wantedKind,
      model: String(request.model || '').trim() || model,
      prompt: String(request.prompt || '').trim().slice(0, 4000),
      voice: request.voice,
      fileBase64: request.fileBase64,
      filename: request.filename,
      ...(wantedKind === 'image' && imageBase64 ? { imageBase64, imageFilename } : {}),
      ...(wantedKind === 'image' && !imageBase64 && request.fileBase64 ? { imageBase64: String(request.fileBase64), imageFilename: String(request.filename || 'source.png') } : {}),
      fallbackModels: [],
      fetchImpl,
      timeoutMs,
      onNote: (note) => { if (onNote) onNote(note); }
    });
    // saveTo + auto-save (desktop parity): image/video results always get a
    // real file path so the model never echoes base64 through more calls.
    const saveTarget = String(request.saveTo || '').trim();
    const saveDataUrl = async (target) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const comma = outcome.dataUrl.indexOf(',');
      if (!outcome.dataUrl.startsWith('data:') || comma <= 0) return false;
      fs.writeFileSync(target, Buffer.from(outcome.dataUrl.slice(comma + 1), 'base64'));
      outcome.savedPath = target;
      return true;
    };
    if (outcome?.ok && saveTarget) {
      if (outcome.dataUrl) await saveDataUrl(path.resolve(saveTarget));
      else if (outcome.url) {
        const response = await fetchImpl(outcome.url, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
        if (!response.ok) throw new Error(`saveTo download failed: HTTP ${response.status}`);
        fs.mkdirSync(path.dirname(path.resolve(saveTarget)), { recursive: true });
        fs.writeFileSync(path.resolve(saveTarget), Buffer.from(await response.arrayBuffer()));
        outcome.savedPath = path.resolve(saveTarget);
      }
    } else if (outcome?.ok && !outcome.savedPath && outcome.dataUrl && (wantedKind === 'image' || wantedKind === 'video')) {
      const dir = outDir ? path.join(outDir, 'agent-assets') : path.join(require('os').tmpdir(), 'browser-use-agent-assets');
      try { await saveDataUrl(path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${wantedKind === 'image' ? 'png' : 'webm'}`)); } catch { /* additive */ }
    }
    return outcome;
  };
}

function createCliCatalogApi({ baseUrl, apiKey, model, providerId = 'cli', connectionId = 'cli', fetchImpl = globalThis.fetch, cacheDir = null } = {}) {
  return async (input = {}) => {
    const request = input && typeof input === 'object' ? input : {};
    const base = String(baseUrl || '').replace(/\/$/, '');
    let discoveredRaw = [];
    let liveError = null;
    if (apiKey && base) {
      try {
        const response = await fetchImpl(`${base}/models`, { headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } });
        if (!response.ok) liveError = `HTTP ${response.status}`;
        else {
          const payload = await response.json();
          discoveredRaw = (Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [])
            .filter((entry) => entry && typeof entry === 'object' && String(entry.id || entry.name || entry.model || '').trim())
            .map((entry) => ({ ...entry, id: String(entry.id || entry.name || entry.model || '').trim() }));
        }
      } catch (error) {
        liveError = String(error?.message || error).slice(0, 120);
      }
    } else if (!apiKey) liveError = 'no API key configured';
    const byId = new Map();
    for (const entry of discoveredRaw) byId.set(entry.id, entry);
    const savedOnly = [];
    if (model && !byId.has(model)) { byId.set(model, { id: model }); savedOnly.push(model); }
    const models = [...byId.values()]
      .map((entry) => compactModelEntry(entry, inferModelKind(entry.id)))
      .filter(Boolean)
      .slice(0, 400);
    const rows = [{
      id: connectionId,
      provider: providerId,
      baseUrlHost: hostOf(baseUrl),
      selectedModel: model || '',
      modelsCount: models.length,
      models,
      savedOnlyCount: savedOnly.length,
      hasApiKey: Boolean(apiKey),
      isActive: true,
      ...(liveError ? { liveCatalog: `saved models only — live discovery failed (${liveError})` } : { liveCatalog: `${discoveredRaw.length} models discovered live from /models` })
    }];
    // Narrow live-capability probe (ladder rung 3): only when the agent
    // explicitly passes probe:true AND narrowed with other filters.
    let probeStats = null;
    if (request.probe && String(request.cap || '').trim()) {
      const capWanted = String(request.cap).trim().toLowerCase();
      const modality = capWanted === 'video-input' ? 'video' : (capWanted === 'vision' || capWanted === 'image-input' ? 'image' : null);
      if (modality && apiKey && base) {
        const searchWanted = String(request.search || '').trim().toLowerCase();
        const candidates = models
          .filter((m) => !searchWanted || m.id.toLowerCase().includes(searchWanted) || String(m.name || '').toLowerCase().includes(searchWanted))
          .sort((a, b) => (a.usdPerM?.[0] ?? Infinity) - (b.usdPerM?.[0] ?? Infinity))
          .slice(0, 24);
        const cachePath = cacheDir ? path.join(cacheDir, 'model-capability-probes.json') : null;
        const cache = cachePath ? loadProbeCache(cachePath) : { entries: {}, dirty: false };
        const probeOutcome = await probeModelsForCapability({
          models: candidates.map((m) => m.id), baseUrl: base, apiKey, modality, cache, cachePath, fetchImpl
        });
        for (const row of rows) {
          for (const m of row.models) {
            const outcome = probeOutcome.results[m.id];
            if (outcome?.conclusive && outcome.supported) {
              m.caps = [...new Set([...(m.caps || []), capWanted])].sort();
              m.capsSource = 'live-probe';
            }
          }
        }
        probeStats = { probed: probeOutcome.probed, deferred: probeOutcome.deferred, cap: capWanted, modality };
      }
    }
    return catalogResponse({ activeConnectionId: connectionId, cloud: {}, ollama: {}, ...(probeStats ? { probe: probeStats } : {}) }, rows, request);
  };
}

module.exports = { createCliModelTaskApi, createCliCatalogApi };
