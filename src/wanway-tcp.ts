import { createServer, type Server, type Socket } from 'node:net';
import { env, envBool } from './env.js';
import { logDeviceFile } from './file-log.js';
import { ingestPing, touchDevice } from './ingest.js';
import type { ConfigStore } from './store.js';
import type { AppConfig } from './types.js';
import { isGpsFix, parseWanwayBuffer, type WanwayFix } from './wanway-protocol.js';

export type WanwayStatus = {
  enabled: boolean;
  host: string;
  ports: number[];
  connections: number;
  packets: number;
  lastImei: string | null;
  lastAt: string | null;
  lastError: string | null;
};

export class WanwayTcp {
  private servers: Server[] = [];
  status: WanwayStatus = {
    enabled: false,
    host: '0.0.0.0',
    ports: [],
    connections: 0,
    packets: 0,
    lastImei: null,
    lastAt: null,
    lastError: null,
  };

  async start(config: AppConfig, store: ConfigStore): Promise<void> {
    const enabled = envBool('WANWAY_TCP_ENABLED', true);
    const host = env('WANWAY_TCP_HOST', '0.0.0.0');
    const ports = parsePorts(env('WANWAY_TCP_PORTS', '21100,5001,8821'));
    this.status = { ...this.status, enabled, host, ports };
    if (!enabled) {
      console.log('WanWay TCP disabled (WANWAY_TCP_ENABLED=false)');
      return;
    }
    for (const port of ports) {
      await this.listen(config, store, host, port);
    }
  }

  stop(): void {
    for (const server of this.servers) server.close();
    this.servers = [];
  }

  private listen(config: AppConfig, store: ConfigStore, host: string, port: number): Promise<void> {
    return new Promise((resolve) => {
      const server = createServer((socket) => this.onSocket(config, store, socket, port));
      server.on('error', (error) => {
        this.status.lastError = `port ${port}: ${error.message}`;
        console.warn(`WanWay listen failed on ${host}:${port} — ${error.message}`);
        resolve();
      });
      server.listen(port, host, () => {
        console.log(`WanWay GPS TCP listening on ${host}:${port}`);
        resolve();
      });
      this.servers.push(server);
    });
  }

  private onSocket(config: AppConfig, store: ConfigStore, socket: Socket, port: number) {
    this.status.connections += 1;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    let buf = Buffer.alloc(0);
    let imei = '';
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`WanWay connection ${remote} on :${port}`);

    socket.on('data', (chunk: Buffer) => {
      logDeviceFile(port, {
        kind: 'raw',
        remote,
        bytes: chunk.length,
        hex: chunk.subarray(0, 512).toString('hex'),
      });
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 65_536) buf = buf.subarray(buf.length - 32_768);
      const parsed = parseWanwayBuffer(buf, imei);
      if (parsed.consumed > 0) buf = buf.subarray(parsed.consumed);
      if (parsed.replies.length) {
        const reply = parsed.replies.length === 1 ? parsed.replies[0] : Buffer.concat(parsed.replies);
        try {
          socket.write(reply);
          logDeviceFile(port, { kind: 'ack', remote, hex: reply.toString('hex') });
        } catch {
          /* closed */
        }
      }
      for (const fix of parsed.fixes) {
        if (fix.imei) imei = fix.imei;
        this.status.packets += 1;
        this.status.lastImei = fix.imei || imei;
        this.status.lastAt = new Date().toISOString();
        logDeviceFile(port, {
          kind: fix.kind,
          remote,
          imei: fix.imei || imei,
          lat: fix.lat,
          lng: fix.lng,
          speedKmh: fix.speedKmh,
          ignition: fix.ignition,
        });
        void persistFix(config, store, fix).catch((error) => {
          this.status.lastError = error instanceof Error ? error.message : String(error);
          console.warn(`WanWay ingest ${fix.imei}: ${this.status.lastError}`);
        });
      }
    });
    socket.on('error', (error) => {
      this.status.lastError = error.message;
    });
    socket.on('close', () => {
      this.status.connections = Math.max(0, this.status.connections - 1);
    });
  }
}

function parsePorts(raw: string): number[] {
  const ports = raw
    .split(/[,\s]+/)
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return [...new Set(ports.length ? ports : [21100])];
}

async function persistFix(config: AppConfig, store: ConfigStore, fix: WanwayFix) {
  if (isGpsFix(fix)) {
    return ingestPing(config, store, {
      deviceId: fix.imei,
      lat: fix.lat,
      lng: fix.lng,
      speedKmh: fix.speedKmh,
      ignition: fix.ignition,
      vendorType: 'WanWay',
      at: fix.at,
    });
  }
  if (!fix.imei) return;
  return touchDevice(fix.imei, { ignition: fix.ignition, vendorType: 'WanWay' });
}
