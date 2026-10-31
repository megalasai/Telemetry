import mqtt from 'mqtt';
import type { AppConfig, GpsSource } from './types.js';
import { logDeviceFile } from './file-log.js';
import { ingestPing, normalizePing, parseTcpLine } from './ingest.js';
import { parsePayload } from './parse.js';
import type { ConfigStore } from './store.js';

export function startMqttSource(config: AppConfig, store: ConfigStore, source: GpsSource): mqtt.MqttClient {
  if (!source.url) throw new Error('MQTT source has no broker URL');
  const client = mqtt.connect(source.url, {
    username: source.mqttUsername,
    password: source.mqttPassword,
    clientId: source.mqttClientId || `digi-telemetry-${source.id}`,
    reconnectPeriod: 5000,
  });
  const topic = source.mqttTopic || 'digi-switchride/gps/#';
  const qos = (source.mqttQos === 0 || source.mqttQos === 2 ? source.mqttQos : 1) as 0 | 1 | 2;

  client.on('connect', () => {
    client.subscribe(topic, { qos }, (error) => {
      if (error) {
        store.markSourceResult(source.id, false, error.message);
        console.warn(`[mqtt:${source.name}] subscribe failed: ${error.message}`);
        return;
      }
      store.markSourceResult(source.id, true);
      console.log(`MQTT source ${source.name} subscribed to ${topic} on ${source.url}`);
    });
  });
  client.on('error', (error) => {
    store.markSourceResult(source.id, false, error.message);
    console.warn(`[mqtt:${source.name}] ${error.message}`);
  });
  client.on('message', (_topic, payload) => {
    void handleMqttPayload(config, store, source, payload.toString('utf8'));
  });
  return client;
}

async function handleMqttPayload(config: AppConfig, store: ConfigStore, source: GpsSource, text: string): Promise<void> {
  try {
    const trimmed = text.trim();
    if (!trimmed) return;
    logDeviceFile('mqtt', { kind: 'mqtt', source: source.name, text: trimmed.slice(0, 4000) });
    let rows: Record<string, unknown>[] = [];
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      rows = parsePayload(JSON.parse(trimmed) as unknown, source.itemsPath, source.map);
    } else {
      const ping = parseTcpLine(trimmed);
      if (ping) {
        await ingestPing(config, store, ping);
        store.markSourceResult(source.id, true);
        return;
      }
    }
    for (const row of rows) {
      const ping = normalizePing(row);
      if (!ping) continue;
      await ingestPing(config, store, ping);
    }
    store.markSourceResult(source.id, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.markSourceResult(source.id, false, message);
  }
}
