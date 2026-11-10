'use strict';
// MODEL CATALOG mapping (agent tool `model_catalog`): /v1/models entries are
// RICH — pricing, context length, capabilities, access tier — and the agent
// tool needs that metadata COMPACT so a 128-model roster stays context-cheap
// while still grounding "strongest / cheapest / which has vision" questions
// in real data instead of the model's name-pattern guesses.
//
// CAPABILITY SOURCE HONESTY: gateway flags are a SUBSET of what a model can
// do. The caller merges provider-page facts (providerModelFacts.cjs — the
// vendor's own structured statement, parsed, cached, zero hardcoding) into
// `caps` and reports the COVERAGE as data (`providerCaps`), so every count
// reflects what is actually known — never a prose guess about families.

function compactModelEntry(entry, kind) {
  const id = String(entry?.id || '').trim();
  if (!id) return null;
  const out = { id, kind };
  if (entry.display_name && entry.display_name !== id) out.name = String(entry.display_name).slice(0, 60);
  const pricing = entry.pricing || {};
  const inputPrice = Number(pricing.input);
  const outputPrice = Number(pricing.output);
  if (Number.isFinite(inputPrice) || Number.isFinite(outputPrice)) {
    out.usdPerM = [
      Number.isFinite(inputPrice) ? Math.round(inputPrice * 10000) / 10000 : null,
      Number.isFinite(outputPrice) ? Math.round(outputPrice * 10000) / 10000 : null
    ];
  }
  if (Number.isFinite(Number(entry.context_length)) && Number(entry.context_length) > 0) out.ctx = Number(entry.context_length);
  if (Number.isFinite(Number(entry.max_output_tokens)) && Number(entry.max_output_tokens) > 0) out.out = Number(entry.max_output_tokens);
  const caps = entry.capabilities || {};
  // EVERY true capability flag the gateway advertises — the facet tallies
  // must answer future flags without a patch here. Live capability PROBES
  // (modelCapabilityProbe.cjs, provider-generic) merge additively elsewhere.
  const set = new Set(Object.entries(caps).filter(([, value]) => value === true).map(([flag]) => flag));
  if (set.size) out.caps = [...set].sort();
  if (entry.access_tier) out.tier = String(entry.access_tier);
  return out;
}

function tally(models, key) {
  return models.reduce((acc, model) => {
    const value = model[key];
    if (Array.isArray(value)) { for (const item of value) acc[item] = (acc[item] || 0) + 1; }
    else if (value !== undefined && value !== null) acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

// TWO-MODE response: without filters a compact SUMMARY (facet counts +
// extremes — "how many / which capabilities" never needs the full blob);
// with any filter only the MATCHING models ride the wire. `extras.providerCaps`
// (data, not prose) reports how much of the catalog carries provider-page facts.
function catalogResponse({ activeConnectionId, cloud, ollama, probe = null }, rows, request = {}) {
  const query = request && typeof request === 'object' ? request : {};
  const hasFilter = [query.kind, query.cap, query.tier, query.search, query.minContext, query.maxInputUsd, query.connectionId]
    .some((value) => value !== undefined && value !== null && String(value).trim() !== '');
  if (!hasFilter) {
    const summaries = rows.map((row) => ({
      id: row.id, provider: row.provider, baseUrlHost: row.baseUrlHost,
      selectedModel: row.selectedModel, isActive: row.isActive, hasApiKey: row.hasApiKey,
      modelsCount: row.modelsCount, savedOnlyCount: row.savedOnlyCount, liveCatalog: row.liveCatalog,
      byKind: tally(row.models, 'kind'),
      byCap: tally(row.models, 'caps'),
      byTier: tally(row.models, 'tier'),
      cheapestPaid: row.models.filter((m) => (m.usdPerM?.[0] ?? Infinity) > 0).sort((a, b) => (a.usdPerM?.[0] ?? Infinity) - (b.usdPerM?.[0] ?? Infinity))[0]?.id || null,
      largestContext: [...row.models].sort((a, b) => (b.ctx || 0) - (a.ctx || 0))[0]?.id || null
    }));
    return {
      mode: 'summary',
      activeConnectionId,
      connections: summaries,
      cloud, ollama,
      ...(probe ? { probe } : {}),
      note: 'SUMMARY (facet counts by kind/capability/tier + cheapest/largest). To LIST actual models pass filters: kind, cap, tier, search, minContext, maxInputUsd, connectionId, limit.'
    };
  }
  const pool = rows.flatMap((row) => row.models.map((model) => ({ ...model, connectionId: row.id, provider: row.provider, isActiveConnection: row.isActive })));
  let matches = pool;
  const kindWanted = String(query.kind || '').trim().toLowerCase();
  if (kindWanted) matches = matches.filter((m) => m.kind === (kindWanted === 'lang' ? 'language' : kindWanted));
  const capWanted = String(query.cap || '').trim().toLowerCase();
  if (capWanted) matches = matches.filter((m) => Array.isArray(m.caps) && m.caps.includes(capWanted));
  const tierWanted = String(query.tier || '').trim().toLowerCase();
  if (tierWanted) matches = matches.filter((m) => m.tier === tierWanted);
  const searchWanted = String(query.search || '').trim().toLowerCase();
  if (searchWanted) matches = matches.filter((m) => m.id.toLowerCase().includes(searchWanted) || String(m.name || '').toLowerCase().includes(searchWanted));
  if (query.minContext !== undefined && String(query.minContext).trim() !== '') matches = matches.filter((m) => (m.ctx || 0) >= Number(query.minContext));
  if (query.maxInputUsd !== undefined && String(query.maxInputUsd).trim() !== '') matches = matches.filter((m) => (m.usdPerM?.[0] ?? Infinity) <= Number(query.maxInputUsd));
  if (String(query.connectionId || '').trim() !== '') matches = matches.filter((m) => m.connectionId === String(query.connectionId).trim());
  const matchedCount = matches.length;
  const limit = Math.max(1, Math.min(Number(query.limit) || 50, 200));
  matches = matches.slice(0, limit);
  return {
    mode: 'filtered',
    matchedCount,
    returnedCount: matches.length,
    models: matches,
    ...(probe ? { probe } : {}),
    ...(matchedCount > limit ? { note: `${matchedCount} matched — showing ${limit}. Raise limit (cap 200) or narrow the filter.` } : {})
  };
}

module.exports = { compactModelEntry, catalogResponse };
