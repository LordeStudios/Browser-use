'use strict';

const str = (description, values) => ({ type: 'string', ...(description ? { description } : {}), ...(values ? { enum: values } : {}) });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const nullable = field => field;
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties: Object.fromEntries(Object.entries(properties).map(([key, field]) => [key, required.includes(key) ? field : nullable(field)])), required, additionalProperties: false });
const point = object({ x: num('x in selected space'), y: num('y in selected space') });
const region = { ...object({ x: num('Left'), y: num('Top'), width: num('Width'), height: num('Height') }), description: 'Observed drawable area (no toolbars); stroke points must stay inside it.' };
const circleShape = { ...object({ cx: num('cx'), cy: num('cy'), radius: num('positive'), startDeg: num('arc start deg; omit/null = 0'), endDeg: num('arc end deg; omit/null = full circle') }), description: 'Parametric circle/arc; a full circle must fit the region.' };
const strokes = { type: 'array', minItems: 1, maxItems: 32, description: '1..32 marks, <=512 points, 10000ms total; each mark is its own down/move/up.', items: object({ points: { type: 'array', minItems: 2, maxItems: 512, items: point, description: '2..512 waypoints; required unless circle' }, circle: circleShape, durationMs: num('ms, default 300'), curve: str('omit/null = none', ['none', 'catmull-rom']), profile: str('omit/null = ease', ['linear', 'ease']) }, []) };
const coordinates = {
  coordinateSpace: str('Omit/null for desktop pixels; screenshot = image pixels with screenshotId.', ['desktop', 'screenshot']),
  screenshotId: str('Latest screenshotId for screenshot coordinates')
};
const { validateStroke } = require('./pointerGesture.cjs');
const define = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: object(properties, required)
});

const COMPUTER_TOOLS = Object.freeze([
  define('computer_observe', 'Inspect displays, windows, and pointer. Coordinates are physical desktop pixels, not browser viewport.'),
  define('computer_pointer', 'Real Windows pointer for NATIVE OS surfaces only (system dialogs, other apps). NEVER for page content: inside the browsing view use browser_click / browser_drag — they act on the DOM and return evidence, while OS drags move windows and prove nothing. Click: action,x,y. Drag: + endX,endY. Wheel: deltas. Polylines: computer_stroke. Omit/null unused fields, never dummy geometry. windowId must be focused and contain the point.', {
    action: str('', ['move', 'down', 'up', 'click', 'drag', 'scroll']), x: num('x'), y: num('y'),
    endX: num('drag end x'), endY: num('drag end y'), button: str('default left', ['left', 'middle', 'right']),
    deltaX: num('positive scrolls right'), deltaY: num('positive scrolls down'), durationMs: num('drag ms, default 300'),
    ...coordinates, windowId: str('focused window handle from computer_observe')
  }, ['action']),
  define('computer_stroke', 'Draw model-planned polylines with the active native app tool via real mouse input. Needs a focused window and observed drawable region. Batch related strokes; no scripts, image generation, import, or auto-tracing.', {
    windowId: str('focused window handle'), region, strokes, ...coordinates,
    button: str('default left', ['left', 'middle', 'right'])
  }, ['windowId', 'region', 'strokes']),
  define('computer_keyboard', 'Send key chords or Unicode text to the focused desktop app.', {
    action: str('', ['press', 'down', 'up', 'text']), key: str('e.g. Control+Shift+S, Enter, Win+D'), text: str('text for action=text')
  }, ['action']),
  define('computer_window', 'List windows or focus a handle from computer_observe. waitMs (list, 0..30000ms): returns as soon as a new window appears; heavy apps need 15-30s, so one call covers launch + verification.', {
    action: str('', ['list', 'focus']), windowId: str('handle from computer_observe'),
    waitMs: num('list: wait ms for a new window')
  }, ['action']),
  define('computer_terminal', 'Conversation-owned PTY. Use for builds, tests, installs, servers, git, formatters, and interactive processes. Source-file mutations are strongly discouraged: use computer_patch (or computer_write for a new/full file) so the user receives a visible diff and write trail. Terminal remains available when the command itself is the requested operation. profile=claude-code = one delegated coding session with workspace-protection instructions; send = one full prompt (raw keystrokes) with revision evidence; read = refresh broker; recover = continue an exited Claude session in the same cwd. Never claim ready/submitted/done/failed without returned phase or evidence.', {
    action: str('', ['execute', 'read', 'list', 'cancel', 'open', 'input', 'send', 'recover', 'close']),
    profile: str('shell|claude-code', ['shell', 'claude-code']), credentialMode: str('Claude child credential selection', ['auto', 'api-key', 'auth-token']),
    newSession: bool('open: true = separate PTY, not the reused session'), command: str('shell profile PowerShell code'), cwd: str('working directory'),
    jobId: str('owned job ID'), sessionId: str('owned PTY session ID'), text: str('raw input or full send text'), expected: str('send: literal output expected before return'),
    offset: num('output char offset, default 0'), limit: num('output page length, default 16000'), waitMs: num('ack ceiling ms')
  }, ['action']),
  define('computer_read', 'Read ONE file completely: text files return numbered lines (cat -n format), whole file up to 2000 lines in one call; encoding=base64 reads binaries paged by bytes — but IMAGE files are NOT returned as bytes (the model cannot decode base64 into vision; open image in a tab + browser_screenshot to see it, or pass bytesOnly:true for genuine asset work). Continuation: returns nextOffset when truncated — re-call with it instead of guessing offsets. If the result has resultId, call read_agent_result with that pointer before re-running the read. Directories -> computer_fs list.', {
    path: str('absolute path of the file to read'),
    offset: num('text: 1-based line to start from (continuations); base64: byte offset'),
    limit: num('lines to return (default 2000, max 2000) — omit for the whole file; base64: bytes (default 524288, max 1048576)'),
    encoding: str('default utf8 (numbered text); base64 for images/binaries', ['utf8', 'base64']),
    bytesOnly: bool('base64 only: force raw bytes for image files (asset work); default false — images return viewing guidance instead'),
    display_text: str('optional label for this call; removed before execution, never reaches a native handler')
  }, ['path']),
  define('computer_write', 'Create or fully overwrite ONE file (mode=append adds to the end). Text by default; encoding=base64 writes binary content (images, archives). Creates parent dirs on request. Returns a line diff for text. Existing text file with targeted changes -> computer_patch instead.', {
    path: str('absolute path of the file to write'),
    content: str('complete file content (mode=write) or text to append (mode=append); base64 for binary payloads'),
    mode: str('default write', ['write', 'append']),
    encoding: str('default utf8', ['utf8', 'base64']),
    createParents: bool('create missing parent directories'),
    acknowledgeExistingChanges: bool('acknowledge a protected pre-existing dirty path'), expectedHash: str('current sha256 from the ownership guard')
  }, ['path', 'content']),
  define('computer_search', 'Fast regex search across a file or tree (ripgrep-backed); ONE call replaces terminal findstr/grep sessions and file-by-file reads. output=content returns file:line:text with optional context lines; output=files returns matching paths RANKED BY MATCH COUNT. Skips node_modules/dist/build/.git and binaries. Search the single most DISTINCTIVE identifier (class name, data attribute, function name, exact UI string) — never broad OR-lists of generic words. mode=definition expands a symbol into a function/method DEFINITION regex. If the result is truncated or carries resultId/nextOffset, retrieve the held result before searching again — a repeat-search notice is evidence, not a reason to rerun.', {
    pattern: str('regular expression; prefer the most distinctive symbol, e.g. "transform-target-id" or "selectionOverlay". For mode=definition: just the bare function name, e.g. "verifySelectedModel"'),
    path: str('absolute file or directory to search'),
    output: str('default content', ['content', 'files']),
    mode: str('default regex', ['regex', 'definition']),
    glob: str('optional glob filter, e.g. "*.css" or "**/*.test.mjs"'),
    context: num('context lines around each match (0-10, default 0)'),
    caseSensitive: bool('default false'), maxResults: num('default 120, max 500')
  }, ['pattern', 'path']),
  define('computer_index', 'A real per-line inverted index over the workspace (Listary-style, in-process). query=<terms>: ranked file:line hits WITH snippets across the whole corpus — docs AND code AND css — in milliseconds; one call replaces chains of sequential searches, and it is the ONLY way to find things written in planning/bug-history docs. Without query: the structural map (symbols/headers/selectors per file), ranked by task-goal overlap; the harness injects the run task. Per-file mtime/size cache: rebuilds re-tokenize only changed files. Workflow: index(query) once -> computer_read the section it names -> patch.', {
    path: str('workspace root to index (defaults to the run workspace)'),
    query: str('space-separated terms; returns ranked file:line hits with snippets across docs+code+css in ms'),
    file: str('optional: outline ONE file in full (all symbols + line numbers) instead of the whole map'),
    maxChars: num('map budget in characters (default 12000, max 40000)'),
    goal: str('optional task text; map files whose names or symbols overlap it rank first (the harness injects the run task automatically)')
  }, []),
  define('computer_fs_batch', 'Ordered filesystem batch for multiple moves/copies/renames/deletes/mkdir operations. Use this to complete a known file operation plan in ONE model decision. The harness preflights paths/ownership, executes sequentially, returns one result per operation, stops on error when requested, and reports the unexecuted tail. It is never concurrent and never accepts shell strings.', {
    operations: { type: 'array', minItems: 1, maxItems: 32, description: 'Ordered operations; each item needs action + absolute path and may carry destination, recursive, overwrite, createParents, acknowledgeExistingChanges, expectedHash.', items: object({
      action: str('operation', ['mkdir', 'copy', 'move', 'delete']), path: str('absolute source/target path'), destination: str('copy/move destination'), recursive: bool('recurse'), overwrite: bool('replace destination'), createParents: bool('create parents'), acknowledgeExistingChanges: bool('acknowledge pre-existing dirty path'), expectedHash: str('ownership hash')
    }, ['action', 'path']) },
    stopOnError: bool('default true: stop on first error and report unexecuted operations')
  }, ['operations']),
  define('computer_fs', 'Filesystem operations WITHOUT content: stat, list (directory), find (locate files by NAME across a tree — the filename counterpart of computer_search), mkdir, copy, move, delete. For file CONTENT use computer_read / computer_write / computer_patch; for locating code by content use computer_search.', {
    action: str('', ['stat', 'list', 'find', 'mkdir', 'copy', 'move', 'delete']), path: str('absolute path'),
    query: str('find: case-insensitive substring matched against file names and relative paths'),
    glob: str('find: optional glob filter, e.g. "*.png"'),
    destination: str('copy/move destination'), recursive: bool('recurse for mkdir/copy/delete/find'),
    acknowledgeExistingChanges: bool('acknowledge a protected pre-existing dirty path'), expectedHash: str('current sha256 or missing/directory token from the ownership guard'),
    offset: num('list/find: entry offset'), limit: num('list/find: entry limit (default 200, max 1000)')
  }, ['action', 'path']),
  define('computer_patch', 'PRIMARY patch tool. Update an EXISTING text file atomically with the proven context-anchored *** Begin Patch format. Use this first. Read once; hunks carry 1-3 context lines. The harness normalizes every Update/Add/Delete File header to the authoritative path argument, so do not waste a retry on a path-header mismatch. If this fails 3 times, switch to computer_patch_live; if cumulative failures reach 6, switch to computer_patch_chunk. After any successful fallback, return to this primary tool for the next edit.', {
    path: str('absolute path of the file to patch'),
    patch: str("full body: '*** Begin Patch' ... '*** End Patch'"),
    acknowledgeExistingChanges: bool('acknowledge a protected pre-existing dirty path'), expectedHash: str('current sha256 for acknowledgment')
  }, ['path', 'patch']),
  define('computer_patch_live', 'FIRST FALLBACK after repeated computer_patch failures. Per-line edit stream with no context hunks: { path, ops: [{op:"append",afterLine:N,lines:[...]}, {op:"replace",line:N,text:"..."}, {op:"delete",line:N}, {op:"insert",line:N,lines:[...]}] }. After success the next edit returns to primary computer_patch; after 6 cumulative failures use computer_patch_chunk.', {
    path: str('absolute path of the file to edit'),
    ops: { type: 'array', items: { type: 'object', properties: { op: str('append | insert | replace | delete', ['append', 'insert', 'replace', 'delete']), line: num('1-based line number'), afterLine: num('append position; 0 = top; omit = EOF'), text: str('replacement text'), lines: { type: 'array', items: str('lines') } }, required: ['op'] }, description: 'ordered per-line operations' }
  }, ['path', 'ops']),
  define('computer_patch_chunk', 'FAIL-PROOF fallback for computer_patch after repeated failures: pure chunk write with NO line numbers, anchors, or context. mode=overwrite writes content verbatim; mode=append adds content at end of file; mode=insert splices content at byte offset (default 0). Use only when computer_patch keeps failing; otherwise prefer computer_patch ops.', {
    path: str('absolute path of the file'),
    mode: str('overwrite | append | insert', ['overwrite', 'append', 'insert']),
    content: str('the chunk of text to write'),
    offset: num('insert mode only: byte offset into the current file (default 0)')
  }, ['path', 'content']),
  define('computer_git', 'Git in a repo working tree. status/diff/log are read-only; add/commit/branch/checkout mutate. Never destructive: no reset, clean, push, pull, rebase, force. Before claiming done: status + diff after edits. Broad diffs are archived when large: use the returned resultId with read_agent_result, or narrow with paths; never repeat the same broad diff after a truncation notice.', {
    action: str('', ['status', 'diff', 'log', 'add', 'commit', 'branch', 'checkout']),
    repo: str('absolute repository working-tree path'),
    paths: { type: 'array', items: str('repo-relative path'), description: 'add/diff paths; omit/null = whole tree' },
    staged: bool('diff: staged changes'), limit: num('log: commits 1..100, default 20'), ref: str('log/checkout ref'),
    name: str('branch: name to create'), message: str('commit message'), create: bool('checkout: create branch (-b)')
  }, ['action', 'repo']),
  define('computer_clipboard', 'Read or replace the system text clipboard.', {
    action: str('', ['read', 'write']), text: str('write text')
  }, ['action']),
  define('computer_screenshot', 'Capture a real display with exact image-to-desktop mapping. Native app visual evidence, not browser_screenshot.', {
    displayId: str('from computer_observe; default primary'), maxWidth: num('default 1600, max 4096')
  ,
    display_text: str('optional label for this call; removed before execution, never reaches a native handler')
  }),
  define('computer_record', 'Record the screen, then READ it as frames: start (choose fps 5-60 — LOW for steady UI, HIGH for animation/motion you need to see smoothly), then stop with frames=N to decode N evenly-spaced stills sized for vision. action=frames decodes ANY existing .mp4/.webm the same way. A vision model cannot watch video — the frames ARE how you review a recording; view one via browser_navigate to its file:/// URL + browser_screenshot. No screenshot-loop recording.', {
    action: str('', ['start', 'status', 'stop', 'frames']), displayId: str('default primary'), path: str('stop: new absolute .mp4/.webm path; frames: the recording to decode'),
    fps: num('5..60, default 30 — YOUR choice by task: low for steady UI, high for animation/motion'), width: num('video width, 320..3840, default 1920'),
    frames: num('stop: decode this many evenly-spaced frames (1-30, default off; 6-12 covers most tasks); frames action: count (1-30, default 6)'),
    frameWidth: num('stop: decoded frame width for vision, 256..2048, default 1024'), count: num('frames action: count (1-30, default 6)'), outDir: str('frames action: output directory (default under agent-results/frames)')
  }, ['action'])
]);
// Keep the full export for compatibility and tests, but do not send the
// specialized 3D/modeling playbook on ordinary browser/file tasks. Claude Code
// and Codex scope instructions to the active task; sending this 1k-word block
// every time diluted the actual objective and increased model re-derivation.
// ONE shared coding-task detector. The keyword regex alone missed natural
// wording like "fix the favourites toggle" — every site that used to keep its
// own copy (tool narrowing, prompt selection, test gate) treated such a task
// as non-coding: browser runs got zero file tools and agi runs got the
// pointer/3D playbook instead of the coding rules. A declared filesystem
// workspace is file work by definition, whatever the wording.
function isCodingTask(task, workspace = null) {
  if (/\b(?:code|coding|file|terminal|powershell|patch|edit|debug|repo|git|npm|test|implement|source)\b/i.test(String(task || ''))) return true;
  if (typeof workspace === 'string') return Boolean(workspace.trim());
  return Boolean(workspace && workspace.root);
}

// Harness prompt, gen5 campaign merge 2026-10-11: gen3 base + validated deltas
// + F7 revert. Deltas kept: Delta 1 evidence-does-not-expire (arch3, verbatim),
// select-options-first with the options read (arch2), the rule-8 adapt-first
// reorder, and the collected-evidence-only summary clause (kept WITH the E12/F3
// matcher, per the arch2 judge). Deltas dropped: the expect-field requirement-id
// coupling and the named-gap skip format (zero evidence). The P8 tamper-ban
// trim was REVERTED by construction — gen3's "Never strip or bypass page
// constraints" line is retained (arch2's tripwire fired 3/8). Restatement trims
// paid for the additions; no rule removed. The killers this file cannot fix in
// prose still ship as loop-side enforcement (E7 constraint-tamper gateway, E8
// blocked-done provenance, E9 rebuild tripwire, and the gen5 F1-F6 fixes) —
// behavioral guarantees live in the loop's enforcement stages, never in
// stacked prompt prose.
// Source: generations/gen5/gen5-active.txt (embedded verbatim, byte-identical)
// + the 3D modeling passage restored below as a situational playbook.
// PROMPT TEXT MOVED (rewrite): V4_AGENT_PROMPT, AGI_PROMPT,
// MODELING_PLAYBOOK, DRAWING_PLAYBOOK and agiPromptForTask no longer live in
// this file. Every harness prompt word is owned by
// desktop/agent/prompt/sections.cjs; this file owns tool schemas, validation
// and app-window DETECTION only. Playbook attachment keys off the live
// desktop observation via hasModelingApp()/hasDrawingApp() below.
// Modeling/3D-CAD app titles (window-title matchers for playbook attachment).
const MODELING_APP_TITLE = /blender|3ds\s?max|3dsmax|maya|zbrush|cinema\s?4d|c4d|houdini|sketchup|fusion\s?360|solidworks|autocad|revit|rhino\s?(?:3d)?|marmoset|substance/i;
// Native drawing/graphics apps (raster, vector, paint, document annotation).
// The 3D/CAD titles are included so a Blender/Maya window also counts as a
// drawing app — those apps draw splines, curves and textures too.
const DRAWING_APP_TITLE = /blender|3ds\s?max|3dsmax|maya|zbrush|cinema\s?4d|c4d|houdini|sketchup|fusion\s?360|solidworks|autocad|revit|rhino\s?(?:3d)?|marmoset|substance|paint|photoshop|gimp|krita|inkscape|illustrator|canva|figma|whiteboard|draw|sketch|clip\s?studio|affinity|designer|recolor|procreate|pixelmator|pencil2d|excalidraw|pdf|comic\s?studio|mspaint|paint\s?net|clipart/i;

function visibleWindows(desktop) {
  if (!desktop || !Array.isArray(desktop.windows)) return [];
  const windows = desktop.windows.filter(window => window && !window.minimized && typeof window.title === 'string');
  const foreground = windows.find(window => String(window.id) === String(desktop.foregroundWindowId));
  return foreground ? [foreground, ...windows.filter(window => window !== foreground)] : windows;
}

function hasModelingApp(desktop) {
  return visibleWindows(desktop).some(window => MODELING_APP_TITLE.test(window.title));
}

function hasDrawingApp(desktop) {
  return visibleWindows(desktop).some(window => DRAWING_APP_TITLE.test(window.title));
}

// Backward compatibility for DIRECT backend callers (tests, sandbox lanes,
// older MCP sessions). computer_file is retired from COMPUTER_TOOLS — the
// model can never select it — but the executor still validates and runs it.
const COMPAT_COMPUTER_FILE = define('computer_file', 'Deprecated everything-tool: use computer_read, computer_write, computer_search, computer_fs, computer_patch.', {
  action: str('', ['list', 'stat', 'read', 'write', 'append', 'edit', 'mkdir', 'copy', 'move', 'delete', 'search']), path: str('absolute path'), content: str('write/append content'),
  encoding: str('default utf8', ['utf8', 'base64']), destination: str('copy/move destination'),
  oldText: str('edit: text to replace'), newText: str('edit: replacement'), replaceAll: bool('edit: replace every match; else unique'),
  overwrite: bool('explicitly replace an existing file'), acknowledgeExistingChanges: bool('acknowledge a protected pre-existing dirty path'), expectedHash: str('current sha256 or missing/directory token from the ownership guard'), recursive: bool('recurse for copy/delete/mkdir/search'), createParents: bool('create parent dirs for write/append/copy/move'),
  numbered: bool('read: 1-based line numbers (recommended before patching)'),
  pattern: str('search: per-line regex across the tree; returns file:line snippets — fastest way to locate code'), query: str('search: literal text; matches filenames unless searchContent'), searchContent: bool('search file contents, not filenames'), caseSensitive: bool('default false'),
  offset: num('utf8 read: 1-based line; base64: byte; list/search: match offset'), limit: num('utf8 read lines (default 1000, max 2000); base64 bytes; list/search entries')
}, ['action', 'path']);

const BY_NAME = new Map(COMPUTER_TOOLS.map(tool => [tool.name, tool]));
// AGI_PROMPT moved (rewrite): AGI-mode guidance now lives as the
// tools:computer section in desktop/agent/prompt/sections.cjs.

const isComputerTool = name => BY_NAME.has(name);
const normalizeControlMode = value => value === 'agi' ? 'agi' : 'browser';
function computerReadOnly(name, input = {}) {
  return name === 'computer_observe' || name === 'computer_screenshot'
    || (name === 'computer_window' && input.action === 'list')
    || (name === 'computer_terminal' && ['read', 'list'].includes(input.action))
    || (name === 'computer_clipboard' && input.action === 'read')
    || name === 'computer_read' || name === 'computer_search' || name === 'computer_index'
    || (name === 'computer_fs' && ['stat', 'list'].includes(input.action))
    || (name === 'computer_file' && ['list', 'read', 'stat', 'search'].includes(input.action))
    || (name === 'computer_git' && ['status', 'diff', 'log'].includes(input.action))
    || (name === 'computer_record' && ['status', 'frames'].includes(input.action));
}
function invalidInput(message, details = {}) {
  const error = new Error(message);
  error.code = 'INVALID_TOOL_INPUT';
  Object.assign(error, details);
  return error;
}
function validateField(field, value, label) {
  let type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  // LORDE_COERCE_NUM_V1 — models commonly send numeric strings ("40", "20")
  // for number fields. Coerce numeric strings before validation so
  // maxResults/limit/waitMs etc. accept both 40 and "40".
  if (type === 'string' && field && field.type === 'number') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) { value = parsed; type = 'number'; }
  }
  if (!field || !(Array.isArray(field.type) ? field.type.includes(type) : type === field.type) || (type === 'number' && !Number.isFinite(value)) || (field.enum && !field.enum.includes(value))) {
    // SELF-DESCRIBING ERRORS: name the field, what was expected, what was
    // sent, and the legal values. "Invalid computer_read.display_text." told
    // the model nothing it could act on — it cost 17 retries guessing.
    const expected = Array.isArray(field?.type) ? field.type.join(' | ') : (field?.type || 'any');
    const received = type === 'array' ? 'array' : type;
    if (field?.enum && !field.enum.includes(value)) {
      throw invalidInput(
        `Invalid value for ${label}: expected one of [${field.enum.join(', ')}], got ${JSON.stringify(value)}.`,
        { field: label, reason: 'invalid_enum_value', expected, received, allowed: field.enum, value }
      );
    }
    if (type === 'number' && !Number.isFinite(value)) {
      throw invalidInput(
        `Invalid value for ${label}: expected a finite number, got ${JSON.stringify(value)}.`,
        { field: label, reason: 'not_finite_number', expected, received, value }
      );
    }
    throw invalidInput(
      `Invalid type for ${label}: expected ${expected}, got ${received}${value === undefined ? ' (undefined)' : ''}.`,
      { field: label, reason: 'invalid_type', expected, received, value }
    );
  }
  if (type === 'string' && value.length > 1_000_000) {
    throw invalidInput(
      `${label} is too large for one call: got ${value.length} characters, the limit is 1000000. Split it across calls.`,
      { field: label, reason: 'too_large', limit: 1_000_000, received: value.length }
    );
  }
  if (type === 'object') {
    const missing = (field.required || []).filter(key => value[key] === undefined);
    if (missing.length) {
      throw invalidInput(
        `${label} requires ${missing.join(', ')}. Missing required field(s): ${missing.join(', ')}. Allowed fields: ${Object.keys(field.properties || {}).join(', ')}.`,
        { field: label, reason: 'missing_required', key: missing[0], missing, allowed: Object.keys(field.properties || {}) }
      );
    }
    const properties = field.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        const allowed = Object.keys(properties).join(', ');
        throw invalidInput(`Unknown ${label}.${key}. Allowed fields: ${allowed}.`, {
          field: `${label}.${key}`,
          reason: 'unknown_field',
          key,
          allowed: Object.keys(properties)
        });
      }
      validateField(properties[key], item, `${label}.${key}`);
    }
  } else if (type === 'array') {
    if (value.length < (field.minItems || 0) || value.length > (field.maxItems ?? Infinity)) {
      const min = field.minItems || 0;
      const max = field.maxItems ?? Infinity;
      throw invalidInput(
        `Invalid length for ${label}: got ${value.length} item(s), allowed ${min}..${max === Infinity ? 'unlimited' : max}.`,
        { field: label, reason: 'invalid_length', minItems: min, maxItems: field.maxItems, received: value.length }
      );
    }
    for (const item of value) validateField(field.items, item, `${label}[]`);
  }
}
function validationSchema(name) {
  const schema = BY_NAME.get(name)?.inputSchema || (name === 'computer_file' ? COMPAT_COMPUTER_FILE.inputSchema : undefined);
  if (!schema || name !== 'computer_pointer') return schema;
  // Compatibility for previously published MCP inputs, not the model-facing
  // ordinary pointer schema. Never guess away contradictory stroke payloads.
  return { ...schema, properties: { ...schema.properties, action: str('Pointer operation', [...schema.properties.action.enum, 'stroke']), region: nullable(region), strokes: nullable(strokes) } };
}
function normalizeComputerInput(name, input) {
  function clean(field, value) {
    if (!field || !value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => clean(field.items, item));
    return Object.fromEntries(Object.entries(value).filter(([key, item]) => {
      const optional = field.properties?.[key] && !field.required?.includes(key);
      return !(optional && (item === null || item === '' && ['windowId', 'screenshotId'].includes(key)));
    }).map(([key, item]) => [key, clean(field.properties?.[key], item)]));
  }
  const normalized = clean(validationSchema(name), input);
  // display_text is accepted as transport metadata for compatibility with MCP
  // clients that label calls, but it must never reach a native/file handler.
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) delete normalized.display_text;
  return normalized;
}
function validateComputerInput(name, input) {
  const tool = BY_NAME.get(name);
  if (!tool && name !== 'computer_file') {
    const known = [...BY_NAME.keys()].filter(key => key.startsWith(String(name).slice(0, 6))).slice(0, 8);
    throw invalidInput(
      `Unknown computer tool "${name}".${known.length ? ` Did you mean: ${known.join(', ')}?` : ` Known tools: ${[...BY_NAME.keys()].slice(0, 12).join(', ')}...`}`,
      { field: name, reason: 'unknown_tool', known: known.length ? known : [...BY_NAME.keys()] }
    );
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidInput(
      `Invalid input for ${name}: expected an object of named fields, got ${input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input}.`,
      { field: name, reason: 'not_an_object', expected: 'object', received: input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input }
    );
  }
  validateField(validationSchema(name), input, name);
  if (name === 'computer_stroke') validateStroke({ ...input, action: 'stroke' });
  if (name === 'computer_pointer') {
    if (input.action === 'stroke') validateStroke(input);
    else if (input.strokes !== undefined) throw invalidInput(
      `Invalid input for ${name}: "strokes" requires action=stroke, but action="${input.action}". Set action="stroke" or remove "strokes".`,
      { field: `${name}.strokes`, reason: 'strokes_requires_stroke_action', expected: 'stroke', received: input.action }
    );
  }
  return tool;
}
module.exports = { COMPUTER_TOOLS, isCodingTask, isComputerTool, computerReadOnly, normalizeControlMode, normalizeComputerInput, validateComputerInput, hasModelingApp, hasDrawingApp };
