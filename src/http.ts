import Fastify from 'fastify';
import { ingestPing, normalizePing } from './ingest.js';
import { listMongoPositions } from './db.js';
import { invalidateHubCache } from './place.js';
import type { Runtime } from './runtime.js';
import { publicSource } from './types.js';
import type { GpsSource, SourceKind } from './types.js';

const KINDS: SourceKind[] = ['pull', 'http_push', 'tcp', 'mqtt'];

export async function startHttp(runtime: Runtime) {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (request, reply) => {
    const cfg = runtime.config;
    reply.header('Access-Control-Allow-Origin', cfg.http.corsOrigin);
    reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (request.method === 'OPTIONS') return reply.code(204).send();

    const path = request.url.split('?')[0];
    if (path === '/health' || path === '/ready' || path === '/') return;

    const provided = readKey(request.headers['x-api-key'], request.headers.authorization);
    const sourceMatch = path.match(/^\/v1\/sources\/([^/]+)\/gps$/);
    if (sourceMatch) {
      const source = runtime.store.getSource(sourceMatch[1]);
      const allowed = [cfg.http.apiKey, source?.apiKey].filter((key): key is string => Boolean(key));
      if (allowed.length && !allowed.includes(provided ?? '')) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'A valid ingest API key is required.' });
      }
      return;
    }
    if (cfg.http.apiKey && provided !== cfg.http.apiKey) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'A valid ingest API key is required.' });
    }
  });

  app.get('/', async () => ({
    service: 'digi-switchride-telemetry',
    sqlite: runtime.store.filePath,
    channels: {
      push: 'POST /v1/gps',
      pull: 'POST /v1/sources/:id/pull',
      sources: 'GET/POST /v1/sources',
      tcp: 'SQLite sources kind=tcp',
      mqtt: 'SQLite sources kind=mqtt',
    },
  }));

  app.get('/health', async () => ({ status: 'ok', service: 'telemetry', wanway: runtime.wanway.status }));
  app.get('/ready', async () => ({ status: 'ok', ...runtime.publicView() }));
  app.get('/v1/config', async () => runtime.publicView());

  app.get('/v1/settings', async () => ({ settings: runtime.publicSettings() }));
  app.put('/v1/settings', async (request) => {
    const body = (request.body ?? {}) as Record<string, string>;
    runtime.store.putSettings(body);
    await runtime.reload();
    return { settings: runtime.publicSettings() };
  });

  app.get('/v1/sources', async () => ({ items: runtime.publicView().sources }));

  app.post('/v1/sources', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<GpsSource> & { name?: string; kind?: SourceKind };
    if (!body.name || !body.kind || !KINDS.includes(body.kind)) {
      return reply.code(400).send({ error: 'VALIDATION', message: 'name and kind (pull|http_push|tcp|mqtt) are required.' });
    }
    const saved = runtime.upsertSource({ ...body, name: body.name, kind: body.kind });
    await runtime.reload();
    return publicSource(saved!);
  });

  app.put('/v1/sources/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<GpsSource>;
    const current = runtime.store.getSource(id);
    if (!current) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Source not found' });
    const saved = runtime.upsertSource({ ...current, ...body, name: body.name ?? current.name, kind: body.kind ?? current.kind }, id);
    await runtime.reload();
    return publicSource(saved!);
  });

  app.delete('/v1/sources/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!runtime.store.deleteSource(id)) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Source not found' });
    await runtime.reload();
    return { id, deleted: true };
  });

  app.post('/v1/sources/:id/pull', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = await runtime.pullNow(id);
      if (!result) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Source not found' });
      return { id, pulled: result.count };
    } catch (error) {
      return reply.code(400).send({ error: 'PULL_FAILED', message: error instanceof Error ? error.message : 'Pull failed' });
    }
  });

  app.post('/v1/reload', async () => {
    await runtime.reload();
    return runtime.publicView();
  });

  app.get('/v1/positions', async () => ({ items: await listMongoPositions() }));

  app.get('/v1/hubs', async () => ({ items: runtime.store.listHubs() }));
  app.post('/v1/hubs', async (request, reply) => {
    const body = (request.body ?? {}) as { id?: string; name?: string; lat?: number; lng?: number; radiusM?: number; status?: string };
    if (!body.id || !body.name || body.lat == null || body.lng == null) {
      return reply.code(400).send({ error: 'VALIDATION', message: 'id, name, lat and lng are required.' });
    }
    runtime.store.upsertHub({
      id: body.id,
      name: body.name,
      lat: Number(body.lat),
      lng: Number(body.lng),
      radiusM: Number(body.radiusM ?? 100),
      status: body.status,
    });
    invalidateHubCache();
    return runtime.store.listHubs().find((h) => h.id === body.id);
  });

  app.post('/v1/gps', async (request, reply) => ingestBody(runtime, request.body, reply));
  app.post('/v1/devices/:deviceId/location', async (request, reply) => {
    const params = request.params as { deviceId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    return ingestBody(runtime, { ...body, deviceId: params.deviceId }, reply);
  });
  app.post('/v1/sources/:id/gps', async (request, reply) => ingestBody(runtime, request.body, reply));
  app.post('/v1/gps/batch', async (request) => {
    const body = request.body as { items?: Record<string, unknown>[] } | Record<string, unknown>[];
    const items = Array.isArray(body) ? body : body.items ?? [];
    const results = [];
    for (const item of items) {
      const ping = normalizePing(item);
      results.push(ping ? await ingestPing(runtime.config, runtime.store, ping) : { updated: false, message: 'Invalid ping' });
    }
    return { count: results.length, items: results };
  });

  await app.listen({ host: runtime.config.http.host, port: runtime.config.http.port });
  return app;
}

function readKey(header: string | string[] | undefined, authorization: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  const auth = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

async function ingestBody(runtime: Runtime, raw: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  const ping = normalizePing((raw ?? {}) as Record<string, unknown>);
  if (!ping) {
    return reply.code(400).send({
      error: 'VALIDATION',
      message: 'Provide deviceId (or vehicleId / registrationNumber) with lat and lng.',
    });
  }
  return ingestPing(runtime.config, runtime.store, ping);
}
