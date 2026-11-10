'use strict';

const fs = require('node:fs');
const path = require('node:path');

function mask(value = '') {
  const text = String(value || '');
  return text ? `••••${text.slice(-4)}` : '';
}

class CredentialStore {
  constructor({ safeStorage, filePath }) {
    this.safeStorage = safeStorage;
    this.filePath = filePath;
  }

  available() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.());
  }

  readAll() {
    try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) || {}; } catch { return {}; }
  }

  writeAll(record) {
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  get(name) {
    if (!this.available()) return '';
    const encoded = this.readAll()[String(name || '')];
    if (!encoded) return '';
    try { return this.safeStorage.decryptString(Buffer.from(encoded, 'base64')); } catch { return ''; }
  }

  set(name, secret) {
    const key = String(name || '');
    const value = String(secret || '').trim();
    if (!key) throw new Error('Credential name is required.');
    if (!this.available()) throw new Error('Secure credential storage is unavailable on this device.');
    const entries = this.readAll();
    if (value) entries[key] = this.safeStorage.encryptString(value).toString('base64');
    else delete entries[key];
    this.writeAll(entries);
    return this.status(key);
  }

  clear(name) { return this.set(name, ''); }

  status(name) {
    const value = this.get(name);
    return { configured: Boolean(value), display: mask(value), secureStorageAvailable: this.available() };
  }
}

module.exports = { CredentialStore, mask };
