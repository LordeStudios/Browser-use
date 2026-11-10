// Attachment source classification (see desktop/attachments_path_flow_chat.md).
// Pure decision logic, shared by the composer's file picker and drag-drop
// handlers. Loaded as a plain script before app.js and also require()-able
// from node tests — no DOM access in here.
(function (root) {
  'use strict';

  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

  // Resolves a File object to its absolute on-disk path. The renderer cannot
  // read File.path since Electron 32; the preload exposes webUtils.getPathForFile.
  // Returns '' when there is no on-disk source (in-memory/synthetic File).
  function resolveFileSourcePath(file) {
    if (!file) return '';
    let resolved = '';
    try { resolved = String(root.browserUseDesktop?.pathForFile?.(file) || ''); } catch { resolved = ''; }
    if (!resolved) {
      // Legacy engines (or a preload without the helper) may still expose the
      // Electron-added File.path property.
      try { resolved = String(file.path || ''); } catch { resolved = ''; }
    }
    return resolved.trim();
  }

  // Decides how ONE filesystem-sourced File becomes a pending attachment.
  //   { mode: 'path', attachment } — owner directive: rides as a source path,
  //                                  no content is copied or read.
  //   { mode: 'copy' }             — no path available: caller falls back to
  //                                  the legacy in-memory copy behavior.
  // `path` may be a file OR a directory (drag-dropped folders have size 0 and
  // an empty MIME type); the backend stats it, so nothing is decided here.
  function classifyFile(file, path) {
    const resolvedPath = path !== undefined ? String(path || '').trim() : resolveFileSourcePath(file);
    if (!resolvedPath) return { mode: 'copy' };
    const mimeType = String(file?.type || '').toLowerCase();
    return {
      mode: 'path',
      attachment: {
        id: (root.crypto && typeof root.crypto.randomUUID === 'function') ? root.crypto.randomUUID() : `path-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: String(file?.name || resolvedPath.split(/[\\/]/).pop() || 'attachment'),
        kind: 'path',
        mimeType,
        path: resolvedPath,
        // Dropped folders report size 0; the backend replaces this with the
        // real stat() size for files.
        size: Math.max(0, Number(file?.size) || 0)
      }
    };
  }

  const api = { IMAGE_TYPES, resolveFileSourcePath, classifyFile };
  root.BrowserUseAttachments = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
