import type { AppConfig, GpsSource } from './types.js';
import { ingestPing, normalizePing } from './ingest.js';
import { parsePayload } from './parse.js';
import type { ConfigStore } from './store.js';

export async function pullSource(config: AppConfig, store: ConfigStore, source: GpsSource): Promise<{ count: number }> {
  if (!source.url) throw new Error('Pull source has no URL');
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...source.headers,
  };
  if (source.apiKey) {
    headers['X-Api-Key'] = source.apiKey;
    if (!headers.Authorization) headers.Authorization = `Bearer ${source.apiKey}`;
  }
  const method = source.method ?? 'GET';
  const res = await fetch(source.url, {
    method,
    headers: {
      ...headers,
      ...(source.body != null && method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: source.body != null && method === 'POST' ? JSON.stringify(source.body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${source.url}`);
  const payload = (await res.json()) as unknown;
  const rows = parsePayload(payload, source.itemsPath, source.map);
  let count = 0;
  for (const row of rows) {
    const ping = normalizePing(row);
    if (!ping) continue;
    try {
      await ingestPing(config, store, ping);
      count += 1;
    } catch (error) {
      if (isPullDuplicate(error)) continue;
      console.warn(`[pull:${source.name}] skip ${ping.deviceId ?? ping.registrationNumber}: ${error instanceof Error ? error.message : error}`);
    }
  }
  store.markSourceResult(source.id, true);
  return { count };
}

export function startPullers(
  config: AppConfig,
  store: ConfigStore,
  sources: GpsSource[],
): Map<string, NodeJS.Timeout> {
  const timers = new Map<string, NodeJS.Timeout>();
  for (const source of sources) {
    if (source.kind !== 'pull' || !source.enabled) continue;
    if (!source.url) {
      store.markSourceResult(source.id, false, 'URL is required for pull sources');
      continue;
    }
    const tick = () => {
      void pullSource(config, store, source).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[pull:${source.name}] ${message}`);
        store.markSourceResult(source.id, false, message);
      });
    };
    tick();
    timers.set(source.id, setInterval(tick, Math.max(1000, source.intervalMs ?? 15000)));
    console.log(`Pull source ${source.name} → ${source.method ?? 'GET'} ${source.url} every ${source.intervalMs ?? 15000}ms`);
  }
  return timers;
}

function isPullDuplicate(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('E11000') || message.includes('duplicate key');
}
