'use strict';

function normalizeDeviceRecord(input = {}) {
  const serial = String(input.serial || input.address || '').trim();
  if (!serial) throw new Error('A device serial or address is required.');
  return {
    serial,
    label: String(input.label || serial).trim().slice(0, 120),
    transport: input.transport === 'usb' ? 'usb' : 'wireless',
    address: String(input.address || (serial.includes(':') ? serial : '')).trim(),
    port: Number.isInteger(Number(input.port)) ? Number(input.port) : null,
    model: input.model ? String(input.model).slice(0, 160) : null,
    product: input.product ? String(input.product).slice(0, 160) : null,
    pairedAt: Number(input.pairedAt) || null,
    lastSeenAt: Number(input.lastSeenAt) || null,
    lastState: String(input.lastState || 'unknown').slice(0, 40),
    programmaticTaps: Boolean(input.programmaticTaps),
    removed: false
  };
}

function mergeDeviceRecord(records, incoming) {
  const next = normalizeDeviceRecord(incoming);
  const existing = records.find((record) => record.serial === next.serial);
  if (!existing) return [...records, next];
  return records.map((record) => record.serial === next.serial ? { ...record, ...next, label: next.label || record.label } : record);
}

module.exports = { normalizeDeviceRecord, mergeDeviceRecord };
