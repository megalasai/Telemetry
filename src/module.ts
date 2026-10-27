import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return metaUrl === pathToFileURL(path.resolve(entry)).href;
}
