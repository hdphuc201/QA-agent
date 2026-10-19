// Test helper: copy a bundled example app without locally generated outputs (discovery, plan,
// generated specs, artifacts), so tests never depend on earlier CLI runs in the repository.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const sampleAppDir = path.join(repoRoot, 'examples/sample-app');

const GENERATED =
  /[\\/](e2e|tests[\\/]qa|qa-artifacts|node_modules)([\\/]|$)|[\\/]\.qa-agent[\\/](?!config\.json$)/;

export function copyExampleApp(name: string, dest: string): void {
  const dir = path.join(repoRoot, 'examples', name);
  fs.cpSync(dir, dest, {
    recursive: true,
    filter: (src) => !GENERATED.test(path.sep + path.relative(dir, src)),
  });
}

export function copySampleApp(dest: string): void {
  copyExampleApp('sample-app', dest);
}
