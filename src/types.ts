export type FieldMap = {
  deviceId?: string;
  vehicleId?: string;
  registrationNumber?: string;
  lat: string;
  lng: string;
  batteryPercent?: string;
  odometerKm?: string;
};

export type SourceKind = 'pull' | 'http_push' | 'tcp' | 'mqtt';

export type GpsSource = {
  id: string;
  name: string;
  kind: SourceKind;
  enabled: boolean;
  url?: string;
  method?: 'GET' | 'POST';
  intervalMs?: number;
  host?: string;
  port?: number;
  path?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  body?: unknown;
  itemsPath?: string;
  map?: FieldMap;
  mqttTopic?: string;
  mqttUsername?: string;
  mqttPassword?: string;
  mqttClientId?: string;
  mqttQos?: number;
  lastError?: string | null;
  lastOkAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type AppConfig = {
  http: {
    enabled: boolean;
    host: string;
    port: number;
    apiKey: string;
    corsOrigin: string;
  };
  locationApi: {
    url: string;
    path: string;
    apiKey: string;
    timeoutMs: number;
  };
  platformApi: {
    url: string;
    telemetryPath: string;
  };
  mongodb: { uri: string };
  trailWindowMs: number;
  hubCacheMs: number;
  sqlitePath: string;
};

export function defaultFieldMap(): FieldMap {
  return {
    deviceId: 'deviceId',
    lat: 'lat',
    lng: 'lng',
    batteryPercent: 'batteryPercent',
    odometerKm: 'odometerKm',
  };
}

export function publicSource(source: GpsSource) {
  return {
    ...source,
    apiKey: source.apiKey ? '(configured)' : '',
    mqttPassword: source.mqttPassword ? '(configured)' : '',
    headers: source.headers ? Object.keys(source.headers) : [],
  };
}
