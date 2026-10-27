import type { FastifyInstance } from 'fastify';
import type { MqttClient } from 'mqtt';
import type { Server } from 'node:net';
import { startHttp } from './http.js';
import { startMqttSource } from './mqtt.js';
import { pullSource, startPullers } from './poller.js';
import type { ConfigStore } from './store.js';
import { startTcpSource } from './tcp.js';
import type { AppConfig, GpsSource } from './types.js';
import { publicSource } from './types.js';
import { WanwayTcp } from './wanway-tcp.js';

export class Runtime {
  private http: FastifyInstance | null = null;
  private tcp = new Map<string, Server>();
  private mqtt = new Map<string, MqttClient>();
  private pullers = new Map<string, NodeJS.Timeout>();
  readonly wanway = new WanwayTcp();
  config: AppConfig;

  constructor(public readonly store: ConfigStore) {
    this.config = store.appConfig();
  }

  publicView() {
    return {
      sqlite: this.store.filePath,
      settings: this.publicSettings(),
      sources: this.store.listSources().map(publicSource),
      wanway: this.wanway.status,
    };
  }

  publicSettings() {
    const all = this.store.allSettings();
    const redacted = { ...all };
    for (const key of Object.keys(redacted)) {
      if (key.includes('password') || key.includes('api_key') || key.includes('uri')) {
        if (redacted[key]) redacted[key] = key.includes('uri') ? redacted[key].replace(/\/\/([^@/]+)@/, '//***@') : '(configured)';
      }
    }
    return redacted;
  }

  async startAdminHttp(): Promise<void> {
    this.config = this.store.appConfig();
    if (!this.config.http.enabled) return;
    this.http = await startHttp(this);
    console.log(`Telemetry HTTP on http://${this.config.http.host}:${this.config.http.port}`);
  }

  async startChannels(): Promise<void> {
    this.config = this.store.appConfig();
    this.stopChannels();
    const sources = this.store.listSources();
    this.pullers = startPullers(this.config, this.store, sources);
    for (const source of sources) {
      if (!source.enabled) continue;
      try {
        if (source.kind === 'tcp') this.tcp.set(source.id, startTcpSource(this.config, this.store, source));
        if (source.kind === 'mqtt') this.mqtt.set(source.id, startMqttSource(this.config, this.store, source));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.markSourceResult(source.id, false, message);
        console.warn(`[${source.kind}:${source.name}] ${message}`);
      }
    }
  }

  stopChannels(): void {
    for (const timer of this.pullers.values()) clearInterval(timer);
    this.pullers.clear();
    for (const server of this.tcp.values()) server.close();
    this.tcp.clear();
    for (const client of this.mqtt.values()) client.end(true);
    this.mqtt.clear();
  }

  async reload(): Promise<void> {
    this.config = this.store.appConfig();
    await this.startChannels();
  }

  async pullNow(id: string) {
    const source = this.store.getSource(id);
    if (!source) return null;
    if (source.kind !== 'pull') throw new Error('Only pull sources can be fetched on demand');
    return pullSource(this.config, this.store, source);
  }

  upsertSource(body: Partial<GpsSource> & { name: string; kind: GpsSource['kind'] }, id?: string) {
    const saved = id ? this.store.updateSource(id, body) : this.store.insertSource({
      id: body.id ?? '',
      name: body.name,
      kind: body.kind,
      enabled: body.enabled ?? true,
      url: body.url,
      method: body.method,
      intervalMs: body.intervalMs,
      host: body.host,
      port: body.port,
      path: body.path,
      apiKey: body.apiKey,
      headers: body.headers,
      body: body.body,
      itemsPath: body.itemsPath,
      map: body.map,
      mqttTopic: body.mqttTopic,
      mqttUsername: body.mqttUsername,
      mqttPassword: body.mqttPassword,
      mqttClientId: body.mqttClientId,
      mqttQos: body.mqttQos,
    });
    return saved;
  }

  async startWanway(): Promise<void> {
    this.config = this.store.appConfig();
    await this.wanway.start(this.config, this.store);
  }

  async shutdown(): Promise<void> {
    this.stopChannels();
    this.wanway.stop();
    if (this.http) await this.http.close();
    this.store.close();
  }
}
