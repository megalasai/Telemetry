import { defaultFieldMap } from './types.js';
export function getPath(value, path) {
    if (!path)
        return undefined;
    let current = value;
    for (const part of path.split('.')) {
        if (current == null || typeof current !== 'object')
            return undefined;
        current = current[part];
    }
    return current;
}
export function extractItems(payload, itemsPath) {
    const root = itemsPath ? getPath(payload, itemsPath) : payload;
    if (Array.isArray(root)) {
        return root.filter((row) => row != null && typeof row === 'object');
    }
    if (root && typeof root === 'object')
        return [root];
    return [];
}
export function applyMap(row, map) {
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
export function parsePayload(payload, itemsPath, map) {
    return extractItems(payload, itemsPath).map((row) => applyMap(row, map));
}
//# sourceMappingURL=parse.js.map