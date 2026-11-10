'use strict';

const MIN_LONG_REPORT_CHARACTERS = 1_000;
const MAX_LONG_REPORT_CHARACTERS = 250_000;
const LONG_REPORT_REQUEST = /\b(?:critique|review|benchmark|stress[\s-]?test|audit|assessment|comparison|report)\b/i;
const EXPLICIT_REPORT_DEPTH = /\b(?:comprehensive|detailed|thorough|extensive|in[\s-]?depth)\b/i;
const UNSAFE_HTML = /<\s*(?:script|iframe|object|embed|form|input|button|textarea|select|base)\b|<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh|\son[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html/i;

function isSafeStaticHtml(content) {
  return !UNSAFE_HTML.test(String(content || ''));
}

function isLongReportRequest(task) {
  return LONG_REPORT_REQUEST.test(String(task || ''));
}

function shouldRequireLongReport(task) {
  const value = String(task || '');
  return LONG_REPORT_REQUEST.test(value) && EXPLICIT_REPORT_DEPTH.test(value);
}

function normalizeReportInput(task, input = {}) {
  if (!isLongReportRequest(task)) {
    throw new Error('Report files are only available for an explicitly requested critique, review, benchmark, stress test, audit, assessment, comparison, or report. Return a normal chat reply instead.');
  }
  const format = String(input.format || '').trim().toLowerCase();
  if (!['txt', 'html'].includes(format)) throw new Error('Report format must be txt or html.');
  const content = String(input.content || '').replace(/\0/g, '').trim();
  if (content.length < MIN_LONG_REPORT_CHARACTERS) {
    throw new Error(`This response is not large enough for a report file (${content.length}/${MIN_LONG_REPORT_CHARACTERS} characters). Return it normally in chat.`);
  }
  if (content.length > MAX_LONG_REPORT_CHARACTERS) throw new Error(`Report content exceeds the ${MAX_LONG_REPORT_CHARACTERS}-character safety limit.`);
  if (format === 'html' && !isSafeStaticHtml(content)) {
    throw new Error('HTML reports must be static. Scripts, embedded frames, forms, event handlers, refresh directives, and script URLs are not allowed.');
  }
  const requestedName = String(input.filename || `browser-use-report.${format}`).trim();
  const stem = requestedName
    .replace(/\.(?:txt|html?)$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
    .trim() || 'browser-use-report';
  return { format, filename: `${stem}.${format}`, content };
}

module.exports = {
  MIN_LONG_REPORT_CHARACTERS,
  MAX_LONG_REPORT_CHARACTERS,
  isLongReportRequest,
  isSafeStaticHtml,
  shouldRequireLongReport,
  normalizeReportInput
};
