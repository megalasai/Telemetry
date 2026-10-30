import path from 'node:path';
import { pathToFileURL } from 'node:url';
export function isMainModule(metaUrl) {
    const entry = process.argv[1];
    if (!entry)
        return false;
    return metaUrl === pathToFileURL(path.resolve(entry)).href;
}
//# sourceMappingURL=module.js.map