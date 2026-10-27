import type { FieldMap } from './types.js';
import { defaultFieldMap } from './types.js';

export function getPath(value: unknown, path?: string): unknown {
  if (!path) return undefined;
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function extractItems(payload: unknown, itemsPath?: string): Record<string, unknown>[] {
  const root = itemsPath ? getPath(payload, itemsPath) : payload;
  if (Array.isArray(root)) {
    return root.filter((row): row is Record<string, unknown> => row != null && typeof row === 'object');
  }
  if (root && typeof root === 'object') return [root as Record<string, unknown>];
  return [];
}

export function applyMap(row: Record<string, unknown>, map?: FieldMap): Record<string, unknown> {
  const fields = map ?? defaultFieldMap();
  return {
    deviceId: getPath(row, fields.deviceId ?? 'deviceId'),
    vehicleId: getPath(row, fields.vehicleId ?? 'vehicleId'),
    registrationNumber: getPath(row, fields.registrationNumber ?? 'registrationNumber') ?? getPath(row, 'name'),
    lat: getPath(row, fields.lat),
    lng: getPath(row, fields.lng),
    batteryPercent: getPath(row, fields.batteryPercent ?? 'batteryPercent'),
    odometerKm: getPath(row, fields.odometerKm ?? 'odometerKm'),
    speedKmh: getPath(row, 'speed') ?? getPath(row, 'speedKmh'),
    ignition: getPath(row, 'ignition'),
    name: getPath(row, 'name'),
  };
}

export function parsePayload(payload: unknown, itemsPath?: string, map?: FieldMap): Record<string, unknown>[] {
  return extractItems(payload, itemsPath).map((row) => applyMap(row, map));
}
