// Artifact scrubber: removes credential values from everything a run leaves behind — Playwright
// trace archives (actions record `fill` values, network logs record request bodies), the Playwright
// HTML report (an embedded base64 zip plus copied traces) and text artifacts (JSON, Markdown, logs).

import fs from 'node:fs';
import path from 'node:path';
import { readZip, writeZip, ZipError } from './zip.ts';

export const MASK = '***';

/** Every textual form a secret can take inside artifacts. */
export function secretVariants(secret: string): string[] {
  const forms = new Set([
    secret,
    encodeURIComponent(secret),
    encodeURIComponent(secret).replace(/%20/g, '+'),
    JSON.stringify(secret).slice(1, -1),
  ]);
  return [...forms].filter((f) => f.length >= 3).sort((a, b) => b.length - a.length);
}

function replaceAll(buf: Buffer, needles: Buffer[]): { buf: Buffer; count: number } {
  let count = 0;
  let out = buf;
  for (const needle of needles) {
    let i = out.indexOf(needle);
    if (i < 0) continue;
    const parts: Buffer[] = [];
    let last = 0;
    while (i >= 0) {
      parts.push(out.subarray(last, i), Buffer.from(MASK));
      last = i + needle.length;
      count++;
      i = out.indexOf(needle, last);
    }
    parts.push(out.subarray(last));
    out = Buffer.concat(parts);
  }
  return { buf: out, count };
}

function scrubZip(buf: Buffer, needles: Buffer[]): { buf: Buffer; count: number } {
  const entries = readZip(buf);
  let count = 0;
  const rewritten = entries.map((e) => {
    const nested = e.name.endsWith('.zip') ? scrubZip(e.data, needles) : replaceAll(e.data, needles);
    count += nested.count;
    return { name: e.name, data: nested.buf };
  });
  return count ? { buf: writeZip(rewritten), count } : { buf, count: 0 };
}

const EMBEDDED_ZIP = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/g;

export interface ScrubReport {
  filesChanged: string[];
  replacements: number;
  errors: string[];
}

/** Scrub every file under `dir` in place. Unreadable archives are reported, never left silently. */
export function scrubArtifacts(dir: string, secrets: string[]): ScrubReport {
  const report: ScrubReport = { filesChanged: [], replacements: 0, errors: [] };
  const needles = [...new Set(secrets.flatMap(secretVariants))].map((s) => Buffer.from(s, 'utf8'));
  if (!needles.length || !fs.existsSync(dir)) return report;
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const file of walk(dir)) {
    const ext = path.extname(file).toLowerCase();
    if (!['.zip', '.html', '.json', '.md', '.txt', '.log', '.trace', '.network', '.yml'].includes(ext)) continue;
    try {
      const original = fs.readFileSync(file);
      let result: { buf: Buffer; count: number };
      if (ext === '.zip') result = scrubZip(original, needles);
      else if (ext === '.html') {
        let count = 0;
        const html = original.toString('utf8').replace(EMBEDDED_ZIP, (whole, b64: string) => {
          const inner = scrubZip(Buffer.from(b64, 'base64'), needles);
          count += inner.count;
          return inner.count ? `data:application/zip;base64,${inner.buf.toString('base64')}` : whole;
        });
        const plain = replaceAll(Buffer.from(html, 'utf8'), needles);
        result = { buf: plain.buf, count: count + plain.count };
      } else result = replaceAll(original, needles);
      if (result.count) {
        fs.writeFileSync(file, result.buf);
        report.filesChanged.push(file);
        report.replacements += result.count;
      }
    } catch (err) {
      report.errors.push(`${file}: ${err instanceof ZipError || err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}
