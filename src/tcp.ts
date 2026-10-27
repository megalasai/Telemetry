import net from 'node:net';
import type { AppConfig, GpsSource } from './types.js';
import type { ConfigStore } from './store.js';
import { ingestPing, parseTcpLine } from './ingest.js';

export function startTcpSource(config: AppConfig, store: ConfigStore, source: GpsSource): net.Server {
  const host = source.host || '0.0.0.0';
  const port = source.port ?? 4210;
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void handleLine(config, store, socket, line);
        newline = buffer.indexOf('\n');
      }
    });
  });
  server.listen(port, host);
  console.log(`TCP source ${source.name} listening on ${host}:${port}`);
  return server;
}

async function handleLine(config: AppConfig, store: ConfigStore, socket: net.Socket, line: string): Promise<void> {
  const ping = parseTcpLine(line);
  if (!ping) {
    socket.write(`${JSON.stringify({ ok: false, error: 'Could not parse GPS line' })}\n`);
    return;
  }
  try {
    const result = await ingestPing(config, store, ping);
    socket.write(`${JSON.stringify({ ok: result.updated, ...result })}\n`);
  } catch (error) {
    socket.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'ingest failed' })}\n`);
  }
}
