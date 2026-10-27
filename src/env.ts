import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(moduleDir, '..');

export function loadEnvFile(): void {
  const envPath = path.join(packageRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function env(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

export function envInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function sqlitePath(): string {
  loadEnvFile();
  const raw = env('TELEMETRY_SQLITE', path.join(packageRoot, 'data', 'telemetry.sqlite'));
  return path.isAbsolute(raw) ? raw : path.resolve(packageRoot, raw);
}

export function bootstrapFromEnv() {
  loadEnvFile();
  return {
    http_enabled: envBool('TELEMETRY_HTTP_ENABLED', true) ? '1' : '0',
    http_host: env('TELEMETRY_HTTP_HOST', '0.0.0.0'),
    http_port: String(envInt('TELEMETRY_HTTP_PORT', 4200)),
    http_api_key: env('TELEMETRY_HTTP_API_KEY', 'dev-gps-ingest'),
    http_cors: env('TELEMETRY_HTTP_CORS', '*'),
    mongodb_uri: env('MONGODB_URI', 'mongodb://localhost:27017/switchride'),
    platform_api_url: env('PLATFORM_API_URL', 'http://localhost:4000').replace(/\/$/, ''),
    platform_telemetry_path: env('PLATFORM_TELEMETRY_PATH', '/api/v1/internal/iot/telemetry'),
    location_api_url: env('LOCATION_API_URL', 'http://localhost:4100').replace(/\/$/, ''),
    location_api_path: env('LOCATION_API_PATH', '/v1/locations/reverse'),
    location_api_key: env('LOCATION_API_KEY', ''),
    location_api_timeout_ms: String(envInt('LOCATION_API_TIMEOUT_MS', 1500)),
    trail_window_ms: String(envInt('TRAIL_WINDOW_MS', 90_000)),
    hub_cache_ms: String(envInt('HUB_CACHE_MS', 30_000)),
    tcp_host: env('TELEMETRY_TCP_HOST', '0.0.0.0'),
    tcp_port: String(envInt('TELEMETRY_TCP_PORT', 4210)),
    tcp_enabled: envBool('TELEMETRY_TCP_ENABLED', true) ? '1' : '0',
    mqtt_url: env('TELEMETRY_MQTT_URL', 'mqtt://127.0.0.1:1883'),
    mqtt_topic: env('TELEMETRY_MQTT_TOPIC', 'digi-switchride/gps/#'),
    mqtt_enabled: envBool('TELEMETRY_MQTT_ENABLED', false) ? '1' : '0',
  };
}
