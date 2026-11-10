'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const limitOf = (value, fallback, max) => Math.min(max, Math.max(1, Math.floor(value ?? fallback)));
const offsetOf = value => Math.max(0, Math.floor(value || 0));
async function statOrNull(file) {
  try { return await fs.promises.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function absolute(value, name = 'path') {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`Use an absolute ${name}.`);
  return path.resolve(value);
}
function bytes(input) {
  if (typeof input.content !== 'string') throw new Error('Write/append requires content.');
  if (input.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) throw new Error('Invalid base64 file content.');
  return Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8');
}

async function atomicWrite(target, data, overwrite, check, expected = null) {
  const existing = await statOrNull(target);
  if (existing && !overwrite) throw new Error('File already exists; pass overwrite=true to replace it.');
  if (existing?.isSymbolicLink()) target = await fs.promises.realpath(target);
  const previous = await statOrNull(target);
  if (previous && !previous.isFile()) throw new Error('The write target is not a regular file.');
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.bu-${crypto.randomUUID()}.tmp`);
  let staged = false;
  try {
    check();
    const handle = await fs.promises.open(temporary, 'wx', previous?.mode);
    staged = true;
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    check();
    if (expected !== null && await fs.promises.readFile(target, 'utf8') !== expected) throw new Error('The file changed during the edit; read it again.');
    const now = await statOrNull(target);
    if (previous && (!now || now.ino !== previous.ino || now.size !== previous.size || now.mtimeMs !== previous.mtimeMs)) throw new Error('The write target changed concurrently; read it again.');
    check();
    if (overwrite) await fs.promises.rename(temporary, target);
    else { await fs.promises.link(temporary, target); await fs.promises.unlink(temporary); }
    staged = false;
  } finally { if (staged) await fs.promises.unlink(temporary).catch(() => {}); }
}

async function fileOperation(input, check) {
  const target = absolute(input.path);
  if (input.action === 'mkdir') {
    check(); await fs.promises.mkdir(target, { recursive: input.recursive === true });
    return { path: target, directory: true };
  }
  if (input.action === 'delete') {
    const stat = await fs.promises.lstat(target); check();
    if (stat.isDirectory() && input.recursive !== true) await fs.promises.rmdir(target);
    else await fs.promises.rm(target, { recursive: input.recursive === true, force: false });
    return { path: target, deleted: true };
  }
  if (input.action === 'copy' || input.action === 'move') {
    const destination = absolute(input.destination, 'destination');
    if (input.createParents) { check(); await fs.promises.mkdir(path.dirname(destination), { recursive: true }); }
    const stat = await fs.promises.lstat(target);
    const same = process.platform === 'win32' ? target.toLowerCase() === destination.toLowerCase() : target === destination;
    if (same) throw new Error('Source and destination are the same path.');
    if (await statOrNull(destination) && input.overwrite !== true) throw new Error('Destination already exists; pass overwrite=true to replace it.');
    check();
    if (input.action === 'move') await fs.promises.rename(target, destination);
    else if (stat.isDirectory()) {
      if (!input.recursive) throw new Error('Directory copy requires recursive=true.');
      await fs.promises.cp(target, destination, { recursive: true, force: input.overwrite === true, errorOnExist: input.overwrite !== true, filter: () => { check(); return true; } });
    } else await fs.promises.copyFile(target, destination, input.overwrite ? 0 : fs.constants.COPYFILE_EXCL);
    return { path: target, destination, operation: input.action, changed: true };
  }
  if (input.action === 'stat') {
    const stat = await fs.promises.lstat(target);
    return { path: target, size: stat.size, directory: stat.isDirectory(), symlink: stat.isSymbolicLink(), modifiedAt: stat.mtime.toISOString() };
  }
  if (input.action === 'list') {
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    const offset = offsetOf(input.offset), limit = limitOf(input.limit, 100, 1000);
    return { path: target, total: entries.length, offset, nextOffset: offset + limit < entries.length ? offset + limit : null,
      entries: entries.slice(offset, offset + limit).map(entry => ({ name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() })) };
  }
  if (input.action === 'read') {
    const encoding = input.encoding === 'base64' ? 'base64' : 'utf8';
    if (encoding === 'base64') {
      // Binary reads keep byte semantics: offset/limit are bytes.
      const offset = offsetOf(input.offset), length = limitOf(input.limit, 32_000, 128_000), handle = await fs.promises.open(target, 'r');
      try {
        const stat = await handle.stat(), buffer = Buffer.alloc(length);
        if (!stat.isFile()) throw new Error('Read requires a regular file.');
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return { path: target, content: buffer.subarray(0, bytesRead).toString('base64'), encoding,
          offset, bytesRead, size: stat.size, nextOffset: offset + bytesRead < stat.size ? offset + bytesRead : null };
      } finally { await handle.close(); }
    }
    // Text reads are LINE-based (Claude-Code semantics — the offset is a
    // 1-based line number and the limit counts lines). Byte-offset reads made
    // models trained on that contract read 70-byte slivers and give up.
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) throw new Error('Read requires a regular file.');
    if (stat.size > 8_000_000) throw new Error('Use terminal tools to read files larger than 8MB.');
    // CRLF is normalized away: a model that echoes read lines back into
    // edit/patch payloads must never have to know the file used \r\n.
    const raw = (await fs.promises.readFile(target, 'utf8')).replace(/\r\n/g, '\n');
    const allLines = raw.split('\n');
    const startLine = Math.max(1, Math.floor(Number(input.offset) || 1));
    const lineLimit = limitOf(input.limit, 1000, 2000);
    const MAX_READ_CHARS = 128_000;
    const MAX_LINE_CHARS = 2_000;
    const slice = [];
    let usedChars = 0;
    let truncated = false;
    for (let i = startLine - 1; i < allLines.length && slice.length < lineLimit; i++) {
      let line = allLines[i];
      if (line.length > MAX_LINE_CHARS) { line = `${line.slice(0, MAX_LINE_CHARS)}…`; truncated = true; }
      if (usedChars + line.length + 1 > MAX_READ_CHARS) { truncated = true; break; }
      slice.push(line);
      usedChars += line.length + 1;
    }
    const nextLine = (startLine - 1 + slice.length) < allLines.length ? startLine + slice.length : null;
    let content = slice.join('\n');
    let firstLine = startLine;
    if (input.numbered === true) {
      content = content.split('\n').map((line, index) => `${String(firstLine + index).padStart(5)}| ${line}`).join('\n');
    }
    return { path: target, content, encoding, numbered: input.numbered === true,
      offset: startLine, lines: slice.length, totalLines: allLines.length, nextLine,
      ...(truncated ? { truncated: true } : {}),
      ...(input.numbered === true ? { notice: 'Line numbers are for reference only. Strip the "    N| " prefix from every line before using it in computer_patch, edit oldText, or write content — the file on disk does not contain them.' } : {}) };
  }
  if (input.action === 'write' || input.action === 'append') {
    const data = bytes(input);
    if (input.createParents) { check(); await fs.promises.mkdir(path.dirname(target), { recursive: true }); }
    check();
    if (input.action === 'append') await fs.promises.appendFile(target, data);
    else await atomicWrite(target, data, input.overwrite === true, check);
    return { path: target, bytesWritten: data.length, changed: true };
  }
  if (input.action === 'edit') {
    if (!input.oldText || typeof input.newText !== 'string') throw new Error('Edit requires non-empty oldText and a newText string.');
    // Defensive: a model that copied numbered-read output into the edit never
    // matches. When EVERY non-empty line carries the "    N| " gutter, strip
    // it exactly as the read notice instructs.
    const fullyNumbered = (text) => {
      const lines = String(text).split('\n').filter(line => line.trim());
      return lines.length > 0 && lines.every(line => /^\s{0,6}\d+\| /.test(line));
    };
    const stripGutter = (text) => String(text).split('\n').map(line => line.replace(/^\s{0,6}\d+\| /, '')).join('\n');
    if (fullyNumbered(input.oldText)) input = { ...input, oldText: stripGutter(input.oldText) };
    if (fullyNumbered(input.newText)) input = { ...input, newText: stripGutter(input.newText) };
    const stat = await fs.promises.stat(target);
    if (stat.size > 8_000_000) throw new Error('Use terminal tools to edit files larger than 8MB.');
    const originalRaw = await fs.promises.readFile(target, 'utf8');
    // Match on LF-normalized text (reads are LF-normalized too, so a model
    // echoing read lines back always matches), but PRESERVE the file's own
    // line endings on write.
    const crlf = originalRaw.includes('\r\n');
    const original = crlf ? originalRaw.replace(/\r\n/g, '\n') : originalRaw;
    const matches = original.split(input.oldText).length - 1;
    if (!matches || matches > 1 && input.replaceAll !== true) throw new Error(`Exact edit matched ${matches} occurrences; require one or explicit replaceAll.`);
    const updated = input.replaceAll ? original.split(input.oldText).join(input.newText) : original.replace(input.oldText, () => input.newText);
    if (updated !== original) {
      const output = crlf ? updated.replace(/\n/g, '\r\n') : updated;
      await atomicWrite(target, Buffer.from(output), true, check, originalRaw);
    }
    return { path: target, replacements: input.replaceAll ? matches : 1, changed: updated !== original };
  }
  if (input.action === 'search') return searchFiles(target, input, check);
  throw new Error('Unknown file operation.');
}

async function searchFiles(root, input, check) {
  if (!input.query) throw new Error('Search requires a non-empty literal query.');
  const query = input.caseSensitive ? input.query : input.query.toLowerCase();
  const matches = [], skipped = [], skippedCounts = {}, offset = offsetOf(input.offset), limit = limitOf(input.limit, 100, 1000);
  // Skipped entries are context noise, not signal: keep the first few as
  // examples and aggregate the rest into counts.
  const noteSkipped = (file, reason) => {
    skippedCounts[reason] = (skippedCounts[reason] || 0) + 1;
    if (skipped.length < 3) skipped.push({ path: file, reason });
  };
  let matched = 0, scanned = 0, more = false, scanLimited = false;
  const contains = text => (input.caseSensitive ? text : text.toLowerCase()).includes(query);
  const add = result => { if (matched++ >= offset) { if (matches.length < limit) matches.push(result); else more = true; } };
  async function visit(directory) {
    check();
    const entries = await fs.promises.opendir(directory);
    for await (const entry of entries) {
      check();
      if (++scanned > 10_000) { scanLimited = true; return; }
      const file = path.join(directory, entry.name);
      if (!input.searchContent && contains(entry.name)) add({ path: file, directory: entry.isDirectory() });
      if (input.searchContent && entry.isFile()) {
        try {
          const stat = await fs.promises.stat(file);
          if (stat.size > 2_000_000) { noteSkipped(file, 'larger-than-2MB; use terminal search'); }
          else {
            const bytes = await fs.promises.readFile(file); check();
            if (bytes.includes(0)) { noteSkipped(file, 'binary'); }
            else {
              const lines = bytes.toString('utf8').split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                if (contains(lines[i])) add({ path: file, line: i + 1, text: lines[i].slice(0, 500) });
                if (more) return;
              }
            }
          }
        } catch (error) { check(); noteSkipped(file, error.code || error.message); }
      }
      if (more || scanLimited) return;
      if (entry.isDirectory() && input.recursive) {
        try { await visit(file); } catch (error) { check(); noteSkipped(file, error.code || error.message); }
      }
      if (more || scanLimited) return;
    }
  }
  await visit(root);
  return { path: root, matches, offset, nextOffset: more ? offset + matches.length : null, scanned, scanLimited,
    // Default mode is FILENAME search — surface that on a zero-match result
    // so the caller corrects to searchContent:true instead of guessing
    // elsewhere or reporting the code as absent.
    ...(matched === 0 && !input.searchContent ? { hint: 'No filename matches. This search compared file NAMES only — set searchContent:true to search inside file contents.' } : {}),
    skipped, skippedCounts,
    complete: !more && !scanLimited && !Object.keys(skippedCounts).length };
}

module.exports = { fileOperation, atomicWrite };
