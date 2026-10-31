import fs from 'node:fs';
import path from 'node:path';
import { env, envInt, loadEnvFile } from './env.js';

const MS_PER_DAY = 86_400_000;

export function fileLogDir(): string {
  loadEnvFile();
  return env('TELEMETRY_FILE_LOG_DIR', '/opt/telemetry');
}

export function fileLogDays(): number {
  return Math.max(1, envInt('TELEMETRY_FILE_LOG_DAYS', 2));
}

function dateStamp(at = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function portFolder(port: string | number): string {
  const raw = String(port).trim() || 'unknown';
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/** Writes one JSON line under /opt/telemetry/YYYY-MM-DD/{port}/received.jsonl then returns. */
export function logDeviceFile(port: string | number, record: Record<string, unknown>): void {
  try {
    const root = fileLogDir();
    const dir = path.join(root, dateStamp(), portFolder(port));
    fs.mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify({ at: new Date().toISOString(), port: String(port), ...record })}\n`;
    fs.appendFileSync(path.join(dir, 'received.jsonl'), line);
  } catch (error) {
    console.warn(`Telemetry file log failed: ${error instanceof Error ? error.message : error}`);
  }
}

export function pruneDeviceFiles(): void {
  const root = fileLogDir();
  const keepDays = fileLogDays();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - keepDays * MS_PER_DAY;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const folderDay = new Date(`${entry.name}T00:00:00`);
    if (Number.isNaN(folderDay.getTime())) continue;
    if (folderDay.getTime() >= cutoff) continue;
    const full = path.join(root, entry.name);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      console.log(`Removed telemetry file log ${full} (older than ${keepDays} days)`);
    } catch (error) {
      console.warn(`Could not remove ${full}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

export function startFileLogRetention(): void {
  pruneDeviceFiles();
  setInterval(pruneDeviceFiles, 60 * 60 * 1000);
}
