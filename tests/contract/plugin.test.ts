import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (rel: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const EXPECTED_SKILLS = ['discover', 'full-test', 'generate', 'plan', 'report', 'run'];
// Skills whose engine exists (phase that implemented them). All others must stay honest skeletons.
const IMPLEMENTED: Record<string, string> = { discover: 'P2', plan: 'P3' };
// Fields accepted by the locally verified Claude Code CLI (2.1.71). `displayName` is rejected there.
const MANIFEST_FIELDS = new Set([
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
]);
const SKILL_FIELDS = new Set([
  'description',
  'argument-hint',
  'disable-model-invocation',
  'allowed-tools',
]);

/** Minimal frontmatter reader: flat `key: value` lines; strings starting with YAML indicators must be quoted. */
function frontmatter(file: string): { fields: Record<string, string | boolean>; body: string } {
  const text = fs.readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(
    match?.[1] !== undefined && match[2] !== undefined,
    `${file}: missing --- frontmatter ---`,
  );
  const fields: Record<string, string | boolean> = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([a-z][a-z-]*): (.+)$/.exec(line);
    assert.ok(kv?.[1] && kv[2], `${file}: unparseable frontmatter line "${line}"`);
    const [, key, raw] = kv;
    assert.ok(!(key in fields), `${file}: duplicate key ${key}`);
    if (raw === 'true' || raw === 'false') fields[key] = raw === 'true';
    else if (raw.startsWith('"')) fields[key] = JSON.parse(raw) as string;
    else {
      assert.doesNotMatch(raw, /^[[{&*!|>'%@`]/, `${file}: ${key} must be quoted`);
      assert.doesNotMatch(raw, /: /, `${file}: ${key} contains ": " and must be quoted`);
      fields[key] = raw;
    }
  }
  return { fields, body: match[2] };
}

describe('plugin manifest', () => {
  test('.claude-plugin/plugin.json has the expected shape', () => {
    const m = readJson('.claude-plugin/plugin.json');
    assert.ok(isRecord(m));
    assert.equal(m.name, 'qa-agent');
    assert.match(String(m.name), /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.doesNotMatch(String(m.name), /^(claude|anthropic)/);
    assert.match(String(m.version), /^\d+\.\d+\.\d+$/);
    assert.ok(typeof m.description === 'string' && m.description.length > 0);
    assert.ok(isRecord(m.author) && typeof m.author.name === 'string');
    for (const key of Object.keys(m))
      assert.ok(MANIFEST_FIELDS.has(key), `unsupported manifest field ${key}`);
  });

  test('only the manifest lives in .claude-plugin/', () => {
    assert.deepEqual(fs.readdirSync(path.join(root, '.claude-plugin')), ['plugin.json']);
  });
});

describe('Playwright MCP config', () => {
  test('.mcp.json pins @playwright/mcp and keeps safe defaults', () => {
    const cfg = readJson('.mcp.json');
    assert.ok(isRecord(cfg) && isRecord(cfg.mcpServers));
    assert.deepEqual(Object.keys(cfg.mcpServers), ['playwright']);
    const pw = cfg.mcpServers.playwright;
    assert.ok(isRecord(pw) && Array.isArray(pw.args));
    const args = pw.args.map(String);
    assert.equal(pw.command, 'npx');
    const pkg = args.find((a) => a.startsWith('@playwright/mcp'));
    assert.match(
      pkg ?? '',
      /^@playwright\/mcp@\d+\.\d+\.\d+$/,
      'package must be pinned to an exact version',
    );
    assert.ok(args.includes('-y'), 'npx must not prompt');
    assert.ok(args.includes('--headless'));
    assert.ok(args.includes('--isolated'), 'no persistent browser profile (cookies) on disk');
    const origins = args[args.indexOf('--allowed-origins') + 1] ?? '';
    assert.deepEqual(origins.split(';').sort(), ['http://127.0.0.1:*', 'http://localhost:*']);
    // Without --output-dir the server writes `.playwright-mcp/` into the target project root.
    assert.equal(args[args.indexOf('--output-dir') + 1], 'qa-artifacts/playwright-mcp');
    for (const forbidden of [
      '--allow-unrestricted-file-access',
      '--no-sandbox',
      '--extension',
      '--caps',
    ]) {
      assert.ok(!args.includes(forbidden), `${forbidden} must not be enabled by default`);
    }
    assert.equal(pw.env, undefined, 'no environment (and no secrets) in .mcp.json');
  });
});

describe('skills', () => {
  test('exactly the six roadmap skills exist', () => {
    const dirs = fs
      .readdirSync(path.join(root, 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    assert.deepEqual(dirs, EXPECTED_SKILLS);
  });

  for (const name of EXPECTED_SKILLS) {
    test(`${name}/SKILL.md frontmatter and status contract`, () => {
      const { fields, body } = frontmatter(path.join(root, 'skills', name, 'SKILL.md'));
      for (const key of Object.keys(fields))
        assert.ok(SKILL_FIELDS.has(key), `${name}: unsupported field ${key}`);
      assert.ok(typeof fields.description === 'string' && fields.description.length >= 40);
      assert.ok(fields.description.length <= 1024, `${name}: description too long`);
      const implementedIn = IMPLEMENTED[name];
      if (implementedIn) {
        assert.doesNotMatch(fields.description, /skeleton/i);
        assert.match(
          body,
          new RegExp(`QA-AGENT-SKILL: ${name} \\| status=implemented \\| phase=${implementedIn}`),
        );
        assert.match(body, /src\/cli\.ts" \w+/, `${name}: must call the deterministic engine`);
      } else {
        assert.match(fields.description, /skeleton/i, `${name}: must not claim to be implemented`);
        assert.match(
          body,
          new RegExp(`QA-AGENT-SKILL: ${name} \\| status=skeleton \\| phase=P\\d`),
        );
      }
      // Skills run only when the user invokes them (they start browsers / write files).
      assert.equal(fields['disable-model-invocation'], true);
      assert.match(body, /\$ARGUMENTS/);
      const tools = fields['allowed-tools'];
      if (tools !== undefined) {
        assert.equal(name, 'discover', 'only discover pre-approves tools');
        for (const tool of String(tools).split(/,\s*/)) {
          assert.match(
            tool,
            /^mcp__plugin_qa-agent_playwright__browser_(navigate|snapshot|close)$/,
          );
        }
      }
    });
  }

  test('discover smoke is restricted to localhost http', () => {
    const { body } = frontmatter(path.join(root, 'skills/discover/SKILL.md'));
    assert.match(body, /`localhost` or `127\.0\.0\.1`/);
    assert.match(body, /Otherwise refuse and stop/);
    assert.match(body, /do not invent page content/);
  });
});
