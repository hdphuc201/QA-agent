// Test helper: copy examples/sample-app without locally generated outputs (discovery, plan,
// generated specs, artifacts), so tests never depend on earlier CLI runs in the repository.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const sampleAppDir = path.join(repoRoot, 'examples/sample-app');

const GENERATED =
  /[\\/](e2e|qa-artifacts|node_modules)([\\/]|$)|[\\/]\.qa-agent[\\/](?!config\.json$)/;

export function copySampleApp(dest: string): void {
  fs.cpSync(sampleAppDir, dest, {
    recursive: true,
    filter: (src) => !GENERATED.test(path.relative(repoRoot, src).replace(/^/, path.sep)),
  });
}
