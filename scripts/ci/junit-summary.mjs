#!/usr/bin/env node
// Markdown failure summary from node:test JUnit output, for $GITHUB_STEP_SUMMARY.
//   node scripts/ci/junit-summary.mjs junit-integration.xml [more.xml ...]

import fs from 'node:fs';

/** @param {string} s */
const unxml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * @param {string} xml
 * @returns {{ total: number, skipped: number, failures: { name: string, message: string }[] }}
 */
export function summarizeJunit(xml) {
  const cases = [...xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)];
  /** @type {{ name: string, message: string }[]} */
  const failures = [];
  let skipped = 0;
  for (const [, attrs = '', , body = ''] of cases) {
    const name = unxml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '?');
    if (/<skipped\b/.test(body)) skipped += 1;
    const failure = /<failure\b([^>]*)>?/.exec(body);
    if (failure) {
      const message = unxml(/\bmessage="([^"]*)"/.exec(failure[1] ?? '')?.[1] ?? 'failed');
      failures.push({ name, message: message.split('\n')[0]?.slice(0, 300) ?? '' });
    }
  }
  return { total: cases.length, skipped, failures };
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')
) {
  const lines = ['## QA Agent integration tests', ''];
  for (const file of process.argv.slice(2)) {
    if (!fs.existsSync(file)) {
      lines.push(`- \`${file}\`: not produced (the test step did not run)`);
      continue;
    }
    const s = summarizeJunit(fs.readFileSync(file, 'utf8'));
    lines.push(
      `- \`${file}\`: ${s.total} test(s), ${s.failures.length} failed, ${s.skipped} skipped`,
    );
    if (s.failures.length) {
      lines.push('', '| Test | Failure |', '| --- | --- |');
      for (const f of s.failures)
        lines.push(`| ${f.name.replace(/\|/g, '\\|')} | ${f.message.replace(/\|/g, '\\|')} |`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
