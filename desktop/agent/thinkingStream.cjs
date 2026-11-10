'use strict';

// CommonJS port of Lorde Design Studio's aiThinkingStream.js. Provider
// callbacks publish cumulative text. Partial literal or encoded markers are
// withheld until the next chunk makes them unambiguous.

const OPEN_MARKER = '<think>';
const CLOSE_MARKER = '</think>';
const VERBOSE_OPEN_MARKER = '<thinking>';
const VERBOSE_CLOSE_MARKER = '</thinking>';
const ENCODED_OPEN_MARKER = '&lt;think&gt;';
const ENCODED_CLOSE_MARKER = '&lt;/think&gt;';
const ENCODED_VERBOSE_OPEN_MARKER = '&lt;thinking&gt;';
const ENCODED_VERBOSE_CLOSE_MARKER = '&lt;/thinking&gt;';

function normalizeThinkingMarkers(value) {
  return String(value || '')
    .replace(/<thinking(\s+[^>]*)?>/gi, (_match, attrs = '') => `<think${attrs || ''}>`)
    .replace(/<\/thinking>/gi, CLOSE_MARKER)
    .replace(/<mm:think(\s+[^>]*)?>/gi, (_match, attrs = '') => `<think${attrs || ''}>`)
    .replace(/<\/mm:think>/gi, CLOSE_MARKER)
    .replace(/<thought(\s+[^>]*)?>/gi, (_match, attrs = '') => `<think${attrs || ''}>`)
    .replace(/<\/thought>/gi, CLOSE_MARKER)
    .replace(/<\|channel>thought\s*\n?/gi, OPEN_MARKER)
    .replace(/<\|channel>response\s*\n?/gi, CLOSE_MARKER)
    .replace(/<channel\|>/gi, CLOSE_MARKER)
    .replace(/&lt;thinking&gt;/gi, OPEN_MARKER)
    .replace(/&lt;\/thinking&gt;/gi, CLOSE_MARKER)
    .replace(/&lt;think&gt;/gi, OPEN_MARKER)
    .replace(/&lt;\/think&gt;/gi, CLOSE_MARKER);
}

function isMarkerPrefix(value) {
  const suffix = String(value || '').toLowerCase();
  return [
    OPEN_MARKER,
    CLOSE_MARKER,
    VERBOSE_OPEN_MARKER,
    VERBOSE_CLOSE_MARKER,
    ENCODED_OPEN_MARKER,
    ENCODED_CLOSE_MARKER,
    ENCODED_VERBOSE_OPEN_MARKER,
    ENCODED_VERBOSE_CLOSE_MARKER
  ]
    .some((marker) => marker.startsWith(suffix));
}

function splitStablePrefix(value, finalize) {
  if (finalize || !value) return { stable: value, pending: '' };
  const maxMarkerLength = Math.max(
    OPEN_MARKER.length,
    CLOSE_MARKER.length,
    VERBOSE_OPEN_MARKER.length,
    VERBOSE_CLOSE_MARKER.length,
    ENCODED_OPEN_MARKER.length,
    ENCODED_CLOSE_MARKER.length,
    ENCODED_VERBOSE_OPEN_MARKER.length,
    ENCODED_VERBOSE_CLOSE_MARKER.length
  );
  const start = Math.max(0, value.length - maxMarkerLength + 1);
  for (let index = start; index < value.length; index += 1) {
    if (isMarkerPrefix(value.slice(index))) {
      return { stable: value.slice(0, index), pending: value.slice(index) };
    }
  }
  return { stable: value, pending: '' };
}

function createSnapshot(thinkingText, replyText, isThinking, segments, activeSegmentIndex) {
  return Object.freeze({
    thinkingText,
    replyText,
    isThinking,
    activeSegmentIndex,
    segments: Object.freeze(segments.map((segment, index) => Object.freeze({
      ...segment,
      isActive: index === activeSegmentIndex,
      isSettled: index !== activeSegmentIndex
    })))
  });
}

function createThinkingStreamSplitter() {
  let source = '';
  let thinkingText = '';
  let replyText = '';
  let pending = '';
  let isThinking = false;
  let segments = [];

  function reset() {
    thinkingText = '';
    replyText = '';
    pending = '';
    isThinking = false;
    segments = [];
  }

  function appendSegment(kind, value) {
    if (!value) return;
    const active = segments.at(-1);
    if (active?.kind === kind) active.text += value;
    else segments.push({ kind, text: value });
  }

  function activeSegmentIndex() {
    const active = segments.at(-1);
    if (!active || !active.text) return -1;
    return segments.length - 1;
  }

  function appendStable(value, finalize = false) {
    const normalized = normalizeThinkingMarkers(`${pending}${value}`);
    const { stable, pending: nextPending } = splitStablePrefix(normalized, finalize);
    pending = nextPending;
    let cursor = 0;

    while (cursor < stable.length) {
      const marker = isThinking ? CLOSE_MARKER : OPEN_MARKER;
      const markerIndex = stable.toLowerCase().indexOf(marker, cursor);
      if (markerIndex < 0) {
        const remainder = stable.slice(cursor);
        if (isThinking) thinkingText += remainder;
        else replyText += remainder;
        appendSegment(isThinking ? 'thinking' : 'reply', remainder);
        break;
      }
      const beforeMarker = stable.slice(cursor, markerIndex);
      if (isThinking) thinkingText += beforeMarker;
      else replyText += beforeMarker;
      appendSegment(isThinking ? 'thinking' : 'reply', beforeMarker);
      isThinking = !isThinking;
      cursor = markerIndex + marker.length;
    }
  }

  function reconcile(nextSource, finalize = false) {
    const value = String(nextSource || '');
    if (!value.startsWith(source)) {
      source = '';
      reset();
    }
    appendStable(value.slice(source.length), finalize);
    source = value;
    segments = segments.filter((segment) => segment.text);
    return createSnapshot(thinkingText, replyText, isThinking, segments, finalize ? -1 : activeSegmentIndex());
  }

  return Object.freeze({
    push(nextSource) { return reconcile(nextSource); },
    finish() { return reconcile(source, true); }
  });
}

module.exports = { createThinkingStreamSplitter, normalizeThinkingMarkers };
