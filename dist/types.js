export function defaultFieldMap() {
    return {
        deviceId: 'deviceId',
        lat: 'lat',
        lng: 'lng',
        batteryPercent: 'batteryPercent',
        odometerKm: 'odometerKm',
    };
}
export function publicSource(source) {
    return {
        ...source,
        apiKey: source.apiKey ? '(configured)' : '',
        mqttPassword: source.mqttPassword ? '(configured)' : '',
        headers: source.headers ? Object.keys(source.headers) : [],
    };
}
//# sourceMappingURL=types.js.map