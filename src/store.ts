import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { bootstrapFromEnv, sqlitePath } from './env.js';
import type { AppConfig, FieldMap, GpsSource, SourceKind } from './types.js';
import { defaultFieldMap } from './types.js';

export class ConfigStore {
  readonly db: DatabaseSync;
  readonly filePath: string;

  constructor(filePath = sqlitePath()) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.createSchema();
    this.seedIfEmpty();
    this.ensureTrack360Source();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        url TEXT,
        method TEXT,
        interval_ms INTEGER,
        host TEXT,
        port INTEGER,
        path TEXT,
        api_key TEXT,
        headers_json TEXT,
        body_json TEXT,
        items_path TEXT,
        map_json TEXT,
        mqtt_topic TEXT,
        mqtt_username TEXT,
        mqtt_password TEXT,
        mqtt_client_id TEXT,
        mqtt_qos INTEGER,
        last_error TEXT,
        last_ok_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind, enabled);
      CREATE TABLE IF NOT EXISTS hubs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        radius_m INTEGER NOT NULL DEFAULT 100,
        status TEXT NOT NULL DEFAULT 'Active'
      );
      CREATE TABLE IF NOT EXISTS positions (
        device_key TEXT PRIMARY KEY,
        device_id TEXT,
        vehicle_id TEXT,
        registration TEXT,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        battery REAL,
        odometer REAL,
        last_place TEXT,
        last_place_kind TEXT,
        last_hub_id TEXT,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_key TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trail_device_at ON trail(device_key, at);
    `);
  }

  private seedIfEmpty(): void {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
    const boot = bootstrapFromEnv();
    if (count.n === 0) {
      const insert = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries(boot)) insert.run(key, value);
    }

    const sources = this.db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number };
    if (sources.n === 0) {
      const now = new Date().toISOString();
      this.insertSource({
        id: 'local-http-push',
        name: 'Local HTTP push API',
        kind: 'http_push',
        enabled: boot.http_enabled === '1',
        host: boot.http_host,
        port: Number(boot.http_port),
        path: '/v1/gps',
        apiKey: boot.http_api_key,
        map: defaultFieldMap(),
        createdAt: now,
        updatedAt: now,
      });
      this.insertSource({
        id: 'local-tcp',
        name: 'Local TCP GPS socket',
        kind: 'tcp',
        enabled: boot.tcp_enabled === '1',
        host: boot.tcp_host,
        port: Number(boot.tcp_port),
        createdAt: now,
        updatedAt: now,
      });
      this.insertSource({
        id: 'local-mqtt',
        name: 'Local MQTT broker',
        kind: 'mqtt',
        enabled: boot.mqtt_enabled === '1',
        url: boot.mqtt_url,
        mqttTopic: boot.mqtt_topic,
        mqttQos: 1,
        map: defaultFieldMap(),
        createdAt: now,
        updatedAt: now,
      });
      this.insertSource({
        id: 'example-vendor-pull',
        name: 'Example vendor pull API',
        kind: 'pull',
        enabled: false,
        url: 'http://localhost:9090/gps/latest',
        method: 'GET',
        intervalMs: 15000,
        headers: { Accept: 'application/json' },
        itemsPath: 'items',
        map: defaultFieldMap(),
        createdAt: now,
        updatedAt: now,
      });
    }

    const hubs = this.db.prepare('SELECT COUNT(*) AS n FROM hubs').get() as { n: number };
    if (hubs.n === 0) {
      this.upsertHub({
        id: 'demo-indiranagar',
        name: 'Indiranagar Demo Hub',
        lat: 12.9784,
        lng: 77.6408,
        radiusM: 250,
        status: 'Active',
      });
    }
  }

  private ensureTrack360Source(): void {
    const now = new Date().toISOString();
    const username = process.env.TRACK360_USERNAME ?? 'tyotaadmin';
    const password = process.env.TRACK360_PASSWORD ?? 'Admin@123';
    const base = process.env.TRACK360_PULL_URL ?? 'https://prod-s1.track360.net.in/api/v1/auth/pull_api';
    const url = new URL(base);
    url.searchParams.set('username', username);
    url.searchParams.set('password', password);
    const patch = {
      name: 'Track360 pull API',
      kind: 'pull' as const,
      enabled: true,
      url: url.toString(),
      method: 'GET' as const,
      intervalMs: 10000,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      },
      itemsPath: 'data',
      map: {
        deviceId: 'deviceImei',
        registrationNumber: 'name',
        lat: 'latitude',
        lng: 'longitude',
        odometerKm: 'totalDistance',
      },
    };
    if (this.getSource('track360-pull')) {
      this.updateSource('track360-pull', patch);
      return;
    }
    this.insertSource({
      id: 'track360-pull',
      ...patch,
      createdAt: now,
      updatedAt: now,
    });
  }

  setting(key: string, fallback = ''): string {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? fallback;
  }

  allSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  putSettings(patch: Record<string, string>): void {
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries(patch)) {
      if (value == null) continue;
      upsert.run(key, String(value));
    }
  }

  appConfig(): AppConfig {
    const url = this.setting('location_api_url', 'http://localhost:4100').replace(/\/$/, '');
    return {
      http: {
        enabled: this.setting('http_enabled', '1') === '1',
        host: this.setting('http_host', '0.0.0.0'),
        port: Number(this.setting('http_port', '4200')),
        apiKey: this.setting('http_api_key', 'dev-gps-ingest'),
        corsOrigin: this.setting('http_cors', '*'),
      },
      locationApi: {
        url,
        path: this.setting('location_api_path', '/v1/locations/reverse'),
        apiKey: this.setting('location_api_key', ''),
        timeoutMs: Number(this.setting('location_api_timeout_ms', '1500')),
      },
      platformApi: {
        url: (this.setting('platform_api_url', '') || process.env.PLATFORM_API_URL || 'http://localhost:4000').replace(/\/$/, ''),
        telemetryPath: this.setting('platform_telemetry_path', '/api/v1/internal/iot/telemetry'),
      },
      mongodb: { uri: this.setting('mongodb_uri', 'mongodb://localhost:27017/switchride') },
      trailWindowMs: Number(this.setting('trail_window_ms', '90000')),
      hubCacheMs: Number(this.setting('hub_cache_ms', '30000')),
      sqlitePath: this.filePath,
    };
  }

  listSources(): GpsSource[] {
    const rows = this.db.prepare('SELECT * FROM sources ORDER BY kind, name').all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToSource(row));
  }

  getSource(id: string): GpsSource | null {
    const row = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSource(row) : null;
  }

  insertSource(source: GpsSource): GpsSource {
    const now = new Date().toISOString();
    const id = source.id || randomUUID();
    this.db
      .prepare(
        `INSERT INTO sources (
          id, name, kind, enabled, url, method, interval_ms, host, port, path, api_key,
          headers_json, body_json, items_path, map_json, mqtt_topic, mqtt_username, mqtt_password,
          mqtt_client_id, mqtt_qos, last_error, last_ok_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        source.name,
        source.kind,
        source.enabled ? 1 : 0,
        sqlValue(source.url),
        source.method ?? 'GET',
        source.intervalMs ?? 15000,
        sqlValue(source.host),
        sqlValue(source.port),
        sqlValue(source.path),
        sqlValue(source.apiKey),
        source.headers ? JSON.stringify(source.headers) : null,
        source.body != null ? JSON.stringify(source.body) : null,
        sqlValue(source.itemsPath),
        JSON.stringify(source.map ?? defaultFieldMap()),
        sqlValue(source.mqttTopic),
        sqlValue(source.mqttUsername),
        sqlValue(source.mqttPassword),
        sqlValue(source.mqttClientId),
        source.mqttQos ?? 1,
        sqlValue(source.lastError),
        sqlValue(source.lastOkAt),
        source.createdAt ?? now,
        source.updatedAt ?? now,
      );
    return this.getSource(id)!;
  }

  updateSource(id: string, patch: Partial<GpsSource>): GpsSource | null {
    const current = this.getSource(id);
    if (!current) return null;
    const next: GpsSource = {
      ...current,
      ...patch,
      id,
      kind: (patch.kind as SourceKind) ?? current.kind,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE sources SET
          name=?, kind=?, enabled=?, url=?, method=?, interval_ms=?, host=?, port=?, path=?, api_key=?,
          headers_json=?, body_json=?, items_path=?, map_json=?, mqtt_topic=?, mqtt_username=?, mqtt_password=?,
          mqtt_client_id=?, mqtt_qos=?, updated_at=?
        WHERE id=?`,
      )
      .run(
        next.name,
        next.kind,
        next.enabled ? 1 : 0,
        sqlValue(next.url),
        next.method ?? 'GET',
        next.intervalMs ?? 15000,
        sqlValue(next.host),
        sqlValue(next.port),
        sqlValue(next.path),
        sqlValue(next.apiKey),
        next.headers ? JSON.stringify(next.headers) : null,
        next.body != null ? JSON.stringify(next.body) : null,
        sqlValue(next.itemsPath),
        JSON.stringify(next.map ?? defaultFieldMap()),
        sqlValue(next.mqttTopic),
        sqlValue(next.mqttUsername),
        sqlValue(next.mqttPassword),
        sqlValue(next.mqttClientId),
        next.mqttQos ?? 1,
        next.updatedAt ?? new Date().toISOString(),
        id,
      );
    return this.getSource(id);
  }

  deleteSource(id: string): boolean {
    const result = this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  markSourceResult(id: string, ok: boolean, error?: string): void {
    this.db
      .prepare('UPDATE sources SET last_error = ?, last_ok_at = CASE WHEN ? THEN ? ELSE last_ok_at END, updated_at = ? WHERE id = ?')
      .run(ok ? null : error ?? 'error', ok ? 1 : 0, new Date().toISOString(), new Date().toISOString(), id);
  }

  close(): void {
    this.db.close();
  }

  listHubs(): { id: string; name: string; lat: number; lng: number; radiusM: number; status: string }[] {
    const rows = this.db.prepare('SELECT * FROM hubs ORDER BY name').all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      lat: Number(row.lat),
      lng: Number(row.lng),
      radiusM: Number(row.radius_m ?? 100),
      status: String(row.status ?? 'Active'),
    }));
  }

  upsertHub(hub: { id: string; name: string; lat: number; lng: number; radiusM: number; status?: string }): void {
    this.db
      .prepare(
        `INSERT INTO hubs (id, name, lat, lng, radius_m, status) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, lat=excluded.lat, lng=excluded.lng, radius_m=excluded.radius_m, status=excluded.status`,
      )
      .run(hub.id, hub.name, hub.lat, hub.lng, hub.radiusM, hub.status ?? 'Active');
  }

  listPositions() {
    return this.db.prepare('SELECT * FROM positions ORDER BY at DESC').all() as Record<string, unknown>[];
  }

  getTrail(deviceKey: string, sinceIso: string) {
    return this.db
      .prepare('SELECT lat, lng, at FROM trail WHERE device_key = ? AND at >= ? ORDER BY at ASC')
      .all(deviceKey, sinceIso) as { lat: number; lng: number; at: string }[];
  }

  savePosition(row: {
    deviceKey: string;
    deviceId?: string;
    vehicleId?: string;
    registration?: string;
    lat: number;
    lng: number;
    battery?: number;
    odometer?: number;
    lastPlace: string;
    lastPlaceKind: string;
    lastHubId: string | null;
    at: string;
    trailWindowMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO positions (
          device_key, device_id, vehicle_id, registration, lat, lng, battery, odometer,
          last_place, last_place_kind, last_hub_id, at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_key) DO UPDATE SET
          device_id=excluded.device_id, vehicle_id=excluded.vehicle_id, registration=excluded.registration,
          lat=excluded.lat, lng=excluded.lng, battery=excluded.battery, odometer=excluded.odometer,
          last_place=excluded.last_place, last_place_kind=excluded.last_place_kind, last_hub_id=excluded.last_hub_id, at=excluded.at`,
      )
      .run(
        row.deviceKey,
        sqlValue(row.deviceId),
        sqlValue(row.vehicleId),
        sqlValue(row.registration),
        row.lat,
        row.lng,
        sqlValue(row.battery),
        sqlValue(row.odometer),
        row.lastPlace,
        row.lastPlaceKind,
        sqlValue(row.lastHubId),
        row.at,
      );
    this.db.prepare('INSERT INTO trail (device_key, lat, lng, at) VALUES (?, ?, ?, ?)').run(row.deviceKey, row.lat, row.lng, row.at);
    const cutoff = new Date(new Date(row.at).getTime() - row.trailWindowMs).toISOString();
    this.db.prepare('DELETE FROM trail WHERE device_key = ? AND at < ?').run(row.deviceKey, cutoff);
  }

  private rowToSource(row: Record<string, unknown>): GpsSource {
    return {
      id: String(row.id),
      name: String(row.name),
      kind: row.kind as SourceKind,
      enabled: Number(row.enabled) === 1,
      url: (row.url as string) || undefined,
      method: ((row.method as string) || 'GET') as 'GET' | 'POST',
      intervalMs: row.interval_ms == null ? undefined : Number(row.interval_ms),
      host: (row.host as string) || undefined,
      port: row.port == null ? undefined : Number(row.port),
      path: (row.path as string) || undefined,
      apiKey: (row.api_key as string) || undefined,
      headers: parseJson<Record<string, string> | undefined>(row.headers_json, undefined),
      body: parseJson<unknown>(row.body_json, undefined),
      itemsPath: (row.items_path as string) || undefined,
      map: parseJson<FieldMap>(row.map_json, defaultFieldMap()),
      mqttTopic: (row.mqtt_topic as string) || undefined,
      mqttUsername: (row.mqtt_username as string) || undefined,
      mqttPassword: (row.mqtt_password as string) || undefined,
      mqttClientId: (row.mqtt_client_id as string) || undefined,
      mqttQos: row.mqtt_qos == null ? undefined : Number(row.mqtt_qos),
      lastError: (row.last_error as string) || null,
      lastOkAt: (row.last_ok_at as string) || null,
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }
}

function sqlValue(value: string | number | null | undefined): string | number | null {
  return value === undefined ? null : value;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
