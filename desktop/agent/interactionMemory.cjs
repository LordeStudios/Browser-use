'use strict';

const crypto = require('node:crypto');
const { hasCoordinatePair } = require('./desktopAgentCoordinator.cjs');

function stable(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 24);
}

function rectOf(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x ?? value.left);
  const y = Number(value.y ?? value.top);
  const width = Number(value.width ?? value.w);
  const height = Number(value.height ?? value.h);
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : null;
}

function layoutState(observation) {
  const dom = observation?.dom || {};
  const viewport = dom.viewport || {};
  const desktop = observation?.desktop;
  const front = desktop?.windows?.find(window => String(window.id) === String(desktop.foregroundWindowId));
  const regions = Array.isArray(dom.regions) ? dom.regions : [];
  const surfaces = regions.slice(0, 24).map(region => ({
    kind: String(region.kind || ''), name: String(region.name || ''), rect: rectOf(region.rect),
    center: region.center || null
  }));
  return {
    domain: desktop ? 'computer' : 'browser',
    url: String(observation?.navigation?.url || dom.url || ''),
    viewport: {
      width: Number(viewport.width) || 0, height: Number(viewport.height) || 0,
      scrollX: Number(viewport.scrollX) || 0, scrollY: Number(viewport.scrollY) || 0,
      devicePixelRatio: Number(viewport.devicePixelRatio || observation?.devicePixelRatio) || 1
    },
    foreground: front ? { id: String(front.id), bounds: rectOf(front.bounds), title: String(front.title || '') } : null,
    surfaces,
    visualTargets: Array.isArray(dom.visualTargets) ? dom.visualTargets.slice(0, 96) : []
  };
}

function contentState(observation) {
  const dom = observation?.dom || {};
  const elements = Array.isArray(dom.elements) ? dom.elements : [];
  const desktop = observation?.desktop;
  const front = desktop?.windows?.find(window => String(window.id) === String(desktop.foregroundWindowId));
  return {
    url: String(observation?.navigation?.url || dom.url || ''),
    title: String(dom.title || ''),
    elements: elements.slice(0, 160).map(element => ({
      index: element.index, tag: element.tag, role: element.role, name: element.name,
      text: String(element.text || '').slice(0, 160), href: element.href,
      rect: rectOf(element.rect), pressed: element.pressed, selected: element.selected,
      expanded: element.expanded, enabled: element.enabled
    })),
    foregroundImage: observation?.screenshot?.windowEvidence?.imageHash || null,
    foregroundTitle: front?.title || null
  };
}

function createInteractionMemory(seed = null) {
  return {
    revision: Number(seed?.revision) || 0,
    layoutRevision: Number(seed?.layoutRevision) || 0,
    contentRevision: Number(seed?.contentRevision) || 0,
    layoutFingerprint: seed?.layoutFingerprint || null,
    contentFingerprint: seed?.contentFingerprint || null,
    previousLayoutFingerprint: seed?.previousLayoutFingerprint || null,
    previousContentFingerprint: seed?.previousContentFingerprint || null,
    layoutChanged: false,
    contentChanged: false,
    surface: seed?.surface || null,
    lastAction: seed?.lastAction || null,
    pendingAction: seed?.pendingAction || null,
    externalChange: Boolean(seed?.externalChange),
    actionSettled: Boolean(seed?.actionSettled),
    staleCoordinateAction: false,
    updatedAt: Number(seed?.updatedAt) || 0
  };
}

function observeInteraction(memory, observation) {
  const nextLayout = layoutState(observation);
  const nextContent = contentState(observation);
  const layoutFingerprint = stable(nextLayout);
  const contentFingerprint = stable(nextContent);
  const layoutChanged = Boolean(memory.layoutFingerprint && memory.layoutFingerprint !== layoutFingerprint);
  const contentChanged = Boolean(memory.contentFingerprint && memory.contentFingerprint !== contentFingerprint);
  memory.previousLayoutFingerprint = memory.layoutFingerprint;
  memory.previousContentFingerprint = memory.contentFingerprint;
  memory.layoutFingerprint = layoutFingerprint;
  memory.contentFingerprint = contentFingerprint;
  memory.layoutChanged = layoutChanged;
  memory.contentChanged = contentChanged;
  memory.surface = nextLayout;
  memory.revision += 1;
  if (layoutChanged || !memory.previousLayoutFingerprint) memory.layoutRevision += 1;
  if (contentChanged || !memory.previousContentFingerprint) memory.contentRevision += 1;
  memory.actionSettled = Boolean(memory.pendingAction && contentChanged);
  memory.externalChange = Boolean(contentChanged && memory.pendingAction === null);
  memory.staleCoordinateAction = false;
  memory.updatedAt = Date.now();
  if (memory.pendingAction) {
    memory.pendingAction = null;
  }
  return {
    layoutChanged,
    contentChanged,
    externalChange: memory.externalChange,
    layoutFingerprint,
    contentFingerprint,
    revision: memory.revision
  };
}

function isCoordinateAction(call) {
  const input = call?.input || {};
  const browserClick = call?.name === 'browser_click' && hasCoordinatePair(input);
  const otherPointerAction = (call?.name === 'browser_drag' || call?.name === 'browser_mousemove'
    || call?.name === 'computer_pointer' || call?.name === 'computer_stroke')
    && (Number.isFinite(input.x) || Number.isFinite(input.startX) || Number.isFinite(input.endX));
  return browserClick || otherPointerAction;
}

function prepareAction(memory, call) {
  // The current decision already received the newest frame. A layout change is
  // therefore information for this action, not a reason to burn another model
  // turn. The next observation will detect any resize that happened during
  // dispatch and settle the pending action against the new frame.
  const remapped = Boolean(memory.layoutChanged && isCoordinateAction(call));
  memory.lastAction = { name: call?.name || '', at: Date.now(), semantic: !isCoordinateAction(call), frameRevision: memory.revision, remapped };
  memory.pendingAction = { name: call?.name || '', revision: memory.revision, contentFingerprint: memory.contentFingerprint };
  return { ok: true, remapped };
}

function context(memory) {
  if (!memory) return null;
  return {
    revision: memory.revision,
    layoutRevision: memory.layoutRevision,
    contentRevision: memory.contentRevision,
    layoutChanged: memory.layoutChanged,
    contentChanged: memory.contentChanged,
    externalChange: memory.externalChange,
    actionSettled: memory.actionSettled,
    staleCoordinateAction: memory.staleCoordinateAction,
    surface: memory.surface,
    lastAction: memory.lastAction,
    pendingAction: memory.pendingAction,
    directive: memory.layoutChanged
      ? 'Layout changed: discard cached coordinates and ground the same semantic target once.'
      : memory.externalChange
        ? 'The environment changed since the last action. Update the plan from the delta; do not remap unchanged geometry.'
        : 'Reuse the current surface frame. Do not rediscover geometry unless evidence contradicts it.'
  };
}

module.exports = { createInteractionMemory, observeInteraction, prepareAction, context, isCoordinateAction };
