import { startHttp } from './http.js';
import { startMqttSource } from './mqtt.js';
import { pullSource, startPullers } from './poller.js';
import { startTcpSource } from './tcp.js';
import { publicSource } from './types.js';
import { WanwayTcp } from './wanway-tcp.js';
export class Runtime {
    store;
    http = null;
    tcp = new Map();
    mqtt = new Map();
    pullers = new Map();
    wanway = new WanwayTcp();
    config;
    constructor(store) {
        this.store = store;
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
                if (redacted[key])
                    redacted[key] = key.includes('uri') ? redacted[key].replace(/\/\/([^@/]+)@/, '//***@') : '(configured)';
            }
        }
        return redacted;
    }
    async startAdminHttp() {
        this.config = this.store.appConfig();
        if (!this.config.http.enabled)
            return;
        this.http = await startHttp(this);
        console.log(`Telemetry HTTP on http://${this.config.http.host}:${this.config.http.port}`);
    }
    async startChannels() {
        this.config = this.store.appConfig();
        this.stopChannels();
        const sources = this.store.listSources();
        this.pullers = startPullers(this.config, this.store, sources);
        for (const source of sources) {
            if (!source.enabled)
                continue;
            try {
                if (source.kind === 'tcp')
                    this.tcp.set(source.id, startTcpSource(this.config, this.store, source));
                if (source.kind === 'mqtt')
                    this.mqtt.set(source.id, startMqttSource(this.config, this.store, source));
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.store.markSourceResult(source.id, false, message);
                console.warn(`[${source.kind}:${source.name}] ${message}`);
            }
        }
    }
    stopChannels() {
        for (const timer of this.pullers.values())
            clearInterval(timer);
        this.pullers.clear();
        for (const server of this.tcp.values())
            server.close();
        this.tcp.clear();
        for (const client of this.mqtt.values())
            client.end(true);
        this.mqtt.clear();
    }
    async reload() {
        this.config = this.store.appConfig();
        await this.startChannels();
    }
    async pullNow(id) {
        const source = this.store.getSource(id);
        if (!source)
            return null;
        if (source.kind !== 'pull')
            throw new Error('Only pull sources can be fetched on demand');
        return pullSource(this.config, this.store, source);
    }
    upsertSource(body, id) {
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
    async startWanway() {
        this.config = this.store.appConfig();
        await this.wanway.start(this.config, this.store);
    }
    async shutdown() {
        this.stopChannels();
        this.wanway.stop();
        if (this.http)
            await this.http.close();
        this.store.close();
    }
}
//# sourceMappingURL=runtime.js.map