import { ConfigStore } from './store.js';
import { Runtime } from './runtime.js';
import { connectMongo, disconnectMongo } from './db.js';
import { isMainModule } from './module.js';

export async function start(): Promise<void> {
  const store = new ConfigStore();
  const runtime = new Runtime(store);
  await connectMongo(runtime.config.mongodb.uri);
  await runtime.startAdminHttp();
  await runtime.startChannels();
  await runtime.startWanway();
  console.log(`SQLite config ${store.filePath}`);
  console.log(`MongoDB GPS ${runtime.config.mongodb.uri.replace(/\/\/([^@/]+)@/, '//***@')}`);
  console.log(`Location API ${runtime.config.locationApi.url}${runtime.config.locationApi.path}`);

  const shutdown = async () => {
    await runtime.shutdown();
    await disconnectMongo();
    process.exit(0);
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

if (isMainModule(import.meta.url)) {
  start().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
