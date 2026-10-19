// Redacts personal machine data from Claude Code stream-json transcripts and smoke logs
// before they are stored as evidence: home directory, user name, and everything in the
// session init that belongs to the owner's other plugins / MCP servers / skills / hooks.
// Usage: node scripts/smoke/redact.mjs <file...>   (rewrites files in place)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OWN = 'qa-agent';

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {{ home?: string, user?: string }} [ctx]
 * @returns {(text: string) => string}
 */
export function makeTextRedactor(ctx = {}) {
  const home = ctx.home ?? os.homedir();
  const user = ctx.user ?? os.userInfo().username;
  const homes = new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')]);
  const patterns = [...homes]
    .filter((h) => h.length > 3)
    .sort((a, b) => b.length - a.length)
    .map((h) => new RegExp(escapeRe(h), 'gi'));
  const userRe = user && user.length >= 3 ? new RegExp(`\\b${escapeRe(user)}\\b`, 'gi') : null;
  return (text) => {
    let out = text;
    for (const re of patterns) out = out.replace(re, '<HOME>');
    if (userRe) out = out.replace(userRe, '<USER>');
    return out;
  };
}

/** @param {string} name */
const isOwn = (name) => name.includes(OWN);
/** Built-ins have no namespace; keep namespaced entries (`x:y`, `mcp__x__y`) only when they are ours. */
/** @param {string} s */
const keepEntry = (s) =>
  s.startsWith('mcp__') ? s.startsWith(`mcp__plugin_${OWN}_`) : !s.includes(':') || isOwn(s);

/**
 * Sanitises one stream-json event (pure; returns a new object).
 * @param {any} event
 * @returns {any}
 */
export function redactEvent(event) {
  if (typeof event !== 'object' || event === null) return event;
  const e = structuredClone(event);
  if (e.type === 'system' && e.subtype === 'init') {
    /** @param {string[] | undefined} list @param {(x: string) => boolean} keep */
    const filter = (list, keep) => {
      if (!Array.isArray(list)) return list;
      const kept = list.filter(keep);
      return kept.length === list.length
        ? kept
        : [...kept, `<${list.length - kept.length} unrelated entries redacted>`];
    };
    e.tools = filter(e.tools, keepEntry);
    e.skills = filter(e.skills, keepEntry);
    e.slash_commands = filter(e.slash_commands, keepEntry);
    if (Array.isArray(e.mcp_servers)) {
      e.mcp_servers = e.mcp_servers.map((/** @type {any} */ s) =>
        isOwn(String(s.name)) ? s : { name: '<redacted>', status: s.status },
      );
    }
    if (Array.isArray(e.plugins)) {
      const own = e.plugins.filter((/** @type {any} */ p) => isOwn(String(p.name)));
      const others = e.plugins.length - own.length;
      e.plugins = others ? [...own, { name: `<${others} unrelated plugin(s) redacted>` }] : own;
    }
  }
  if (e.type === 'system' && typeof e.subtype === 'string' && e.subtype.startsWith('hook')) {
    for (const key of ['output', 'stdout', 'stderr']) {
      if (typeof e[key] === 'string' && e[key]) e[key] = '<user hook output redacted>';
    }
  }
  return e;
}

/**
 * @param {string} jsonl
 * @param {(text: string) => string} redactText
 */
export function redactTranscript(jsonl, redactText) {
  return jsonl
    .split('\n')
    .map((line) => {
      if (!line.trim().startsWith('{')) return redactText(line);
      return redactText(JSON.stringify(redactEvent(JSON.parse(line))));
    })
    .join('\n');
}

/** @param {string} file @param {(text: string) => string} redactText */
export function redactFile(file, redactText) {
  const text = fs.readFileSync(file, 'utf8');
  let out;
  if (file.endsWith('.jsonl')) out = redactTranscript(text, redactText);
  else if (file.endsWith('.json')) {
    const data = JSON.parse(text);
    if (Array.isArray(data.plugins))
      data.plugins = redactEvent({
        type: 'system',
        subtype: 'init',
        plugins: data.plugins,
      }).plugins;
    out = redactText(`${JSON.stringify(data, null, 2)}\n`);
  } else out = redactText(text);
  if (out !== text) fs.writeFileSync(file, out);
  return out !== text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const redactText = makeTextRedactor();
  for (const file of process.argv.slice(2)) {
    process.stdout.write(`${redactFile(file, redactText) ? 'redacted' : 'unchanged'} ${file}\n`);
  }
}
