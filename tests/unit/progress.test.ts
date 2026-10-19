import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, parseRoadmap, renderStatus, validateSchema } from '../../scripts/progress.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repoRoot, 'scripts/progress.mjs');
const roadmap = path.join(repoRoot, 'QA_AGENT_MASTER_ROADMAP.md');
const realState = path.join(repoRoot, 'planning/progress.json');
const tempRoots: string[] = [];

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(root: string, ...args: string[]): Result {
  const r = spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function ok(root: string, ...args: string[]): Result {
  const r = cli(root, ...args);
  assert.equal(r.code, EXIT.OK, `expected exit 0 for ${args.join(' ')}\n${r.stderr}`);
  return r;
}

/** Fresh temp repository root containing only a copy of the roadmap (never the real state). */
function makeRoot(init = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-progress-'));
  tempRoots.push(root);
  fs.copyFileSync(roadmap, path.join(root, 'QA_AGENT_MASTER_ROADMAP.md'));
  if (init) ok(root, 'init');
  return root;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const state = (root: string) => JSON.parse(read(root, 'planning/progress.json'));
const writeState = (root: string, s: unknown) =>
  fs.writeFileSync(path.join(root, 'planning/progress.json'), JSON.stringify(s, null, 2));
const sha = (file: string) =>
  fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent';

function completeAllP0(root: string) {
  for (const id of Object.keys(state(root).phases.P0.tasks)) {
    ok(root, 'start', 'P0', id);
    ok(root, 'complete', 'P0', id, '--evidence', `npm test for ${id}: exit=0`);
  }
}

let realStateHash = '';
before(() => {
  realStateHash = sha(realState);
});
after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  assert.equal(
    sha(realState),
    realStateHash,
    'tests must never modify the real planning/progress.json',
  );
});

describe('roadmap inventory', () => {
  test('parses all P0–P9 phases and task ids from the roadmap', () => {
    const inv = parseRoadmap(fs.readFileSync(roadmap, 'utf8'));
    assert.deepEqual(Object.keys(inv.phases), [
      'P0',
      'P1',
      'P2',
      'P3',
      'P4',
      'P5',
      'P6',
      'P7',
      'P8',
      'P9',
    ]);
    const total = Object.values(inv.phases).reduce((n, p) => n + Object.keys(p.tasks).length, 0);
    assert.equal(total, 62);
    assert.equal(inv.phases.P0?.title, 'BOOTSTRAP & AUTOMATED PROGRESS');
    assert.ok(inv.phases.P8?.tasks['P8-T07']);
  });

  test('ignores task ids listed under the wrong phase heading', () => {
    const inv = parseRoadmap('### P0 — A\n- [ ] **P0-T01** — ok\n- [ ] **P1-T01** — misplaced\n');
    assert.deepEqual(Object.keys(inv.phases.P0?.tasks ?? {}), ['P0-T01']);
  });
});

describe('init', () => {
  test('creates state, status and worklog with the full inventory', () => {
    const root = makeRoot();
    const s = state(root);
    assert.deepEqual(validateSchema(s), []);
    assert.equal(Object.keys(s.phases).length, 10);
    assert.equal(s.phases.P0.tasks['P0-T01'].status, 'not_started');
    assert.match(read(root, 'docs/PROJECT_STATUS.md'), /0\/62 completed \(0\.0%\)/);
    assert.match(read(root, 'docs/WORKLOG.md'), /\| init \| created \|/);
    ok(root, 'check');
  });

  test('is idempotent: a second run changes nothing', () => {
    const root = makeRoot();
    const before = ['planning/progress.json', 'docs/PROJECT_STATUS.md', 'docs/WORKLOG.md'].map(
      (f) => read(root, f),
    );
    const r = ok(root, 'init');
    assert.match(r.stdout, /0 missing task\(s\) added/);
    const after = ['planning/progress.json', 'docs/PROJECT_STATUS.md', 'docs/WORKLOG.md'].map((f) =>
      read(root, f),
    );
    assert.deepEqual(after, before);
  });

  test('merges missing tasks without discarding existing progress', () => {
    const root = makeRoot();
    ok(root, 'start', 'P0', 'P0-T01');
    const s = state(root);
    delete s.phases.P9.tasks['P9-T06'];
    writeState(root, s);
    assert.equal(cli(root, 'check').code, EXIT.VALIDATION);
    assert.match(ok(root, 'init').stdout, /1 missing task\(s\) added/);
    const merged = state(root);
    assert.equal(merged.phases.P0.tasks['P0-T01'].status, 'in_progress');
    assert.equal(merged.phases.P9.tasks['P9-T06'].status, 'not_started');
    ok(root, 'check');
  });
});

describe('task transitions', () => {
  test('start + complete updates state, status markdown and worklog', () => {
    const root = makeRoot();
    ok(root, 'start', 'P0', 'P0-T01');
    let md = read(root, 'docs/PROJECT_STATUS.md');
    assert.match(md, /## In progress\n\n- P0-T01/);
    assert.match(
      md,
      /\| P0 \| BOOTSTRAP & AUTOMATED PROGRESS \| in_progress \| pending \| 0\/7 \|/,
    );
    ok(root, 'complete', 'P0', 'P0-T01', '--evidence', 'git status --short: exit=0');
    md = read(root, 'docs/PROJECT_STATUS.md');
    assert.match(md, /\| P0-T01 \| completed \| .* \| git status --short: exit=0 \|/);
    assert.match(md, /1\/62 completed \(1\.6%\)/);
    const t = state(root).phases.P0.tasks['P0-T01'];
    assert.equal(t.status, 'completed');
    assert.equal(t.evidence[0].text, 'git status --short: exit=0');
    assert.ok(t.completedAt >= t.startedAt);
    const log = read(root, 'docs/WORKLOG.md');
    assert.match(log, /\| P0 \| P0-T01 \| start \| in_progress/);
    assert.match(
      log,
      /\| P0 \| P0-T01 \| complete \| completed \| evidence: git status --short: exit=0/,
    );
    ok(root, 'check');
  });

  test('block shows the reason in status and start resumes the task', () => {
    const root = makeRoot();
    ok(root, 'start', 'P0', 'P0-T02');
    ok(root, 'block', 'P0', 'P0-T02', '--reason', 'Node runtime unavailable');
    let md = read(root, 'docs/PROJECT_STATUS.md');
    assert.match(md, /## Blocked\n\n- P0-T02 — Node runtime unavailable/);
    assert.match(ok(root, 'summary').stdout, /Blocked: P0-T02 \(Node runtime unavailable\)/);
    ok(root, 'check');
    ok(root, 'start', 'P0', 'P0-T02');
    const t = state(root).phases.P0.tasks['P0-T02'];
    assert.equal(t.status, 'in_progress');
    assert.ok(t.blockers[0].resolvedAt);
    md = read(root, 'docs/PROJECT_STATUS.md');
    assert.match(md, /## Blocked\n\n_None_/);
    assert.match(read(root, 'docs/WORKLOG.md'), /\| P0-T02 \| unblock \| in_progress/);
    ok(root, 'check');
  });

  test('rejects invalid transitions with exit 1 and leaves state untouched', () => {
    const root = makeRoot();
    const cases: string[][] = [
      ['complete', 'P0', 'P0-T01', '--evidence', 'npm test: exit=0'], // not started
      ['start', 'P0', 'P0-T99'], // unknown task
    ];
    for (const args of cases) {
      const before = read(root, 'planning/progress.json');
      assert.equal(cli(root, ...args).code, EXIT.VALIDATION, args.join(' '));
      assert.equal(read(root, 'planning/progress.json'), before);
    }
    ok(root, 'start', 'P0', 'P0-T01');
    assert.equal(cli(root, 'start', 'P0', 'P0-T01').code, EXIT.VALIDATION); // already in progress
    ok(root, 'complete', 'P0', 'P0-T01', '--evidence', 'npm test: exit=0');
    assert.equal(cli(root, 'start', 'P0', 'P0-T01').code, EXIT.VALIDATION); // completed is final
    assert.equal(cli(root, 'block', 'P0', 'P0-T01', '--reason', 'x').code, EXIT.VALIDATION);
    assert.equal(
      cli(root, 'complete', 'P0', 'P0-T01', '--evidence', 'npm test: exit=0').code,
      EXIT.VALIDATION,
    );
  });

  test('cannot start a task of the next phase before the previous gate passed', () => {
    const root = makeRoot();
    const r = cli(root, 'start', 'P1', 'P1-T01');
    assert.equal(r.code, EXIT.VALIDATION);
    assert.match(r.stderr, /previous phase P0 gate is pending/);
  });
});

describe('evidence validation', () => {
  test('requires concrete evidence', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'evidence'));
    fs.writeFileSync(path.join(root, 'evidence/run.log'), 'ok');
    ok(root, 'start', 'P0', 'P0-T01');
    const rejected: [string[], number, RegExp][] = [
      [[], EXIT.USAGE, /requires at least one --evidence/],
      [['--evidence', 'done'], EXIT.VALIDATION, /too short/],
      [['--evidence', 'all tests have been run'], EXIT.VALIDATION, /exit code/],
      [['--evidence', 'see docs/missing-file.md'], EXIT.VALIDATION, /missing file/],
      [['--evidence', 'see ../../outside/secret.txt'], EXIT.VALIDATION, /escapes repository root/],
    ];
    for (const [args, code, pattern] of rejected) {
      const r = cli(root, 'complete', 'P0', 'P0-T01', ...args);
      assert.equal(r.code, code, args.join(' '));
      assert.match(r.stderr, pattern);
    }
    assert.equal(state(root).phases.P0.tasks['P0-T01'].status, 'in_progress');
    ok(root, 'complete', 'P0', 'P0-T01', '--evidence', 'output saved to evidence/run.log');
  });

  test('block requires a reason', () => {
    const root = makeRoot();
    assert.equal(cli(root, 'block', 'P0', 'P0-T01').code, EXIT.USAGE);
  });
});

describe('gate', () => {
  test('passes only when all tasks are complete, the review exists and check is clean', () => {
    const root = makeRoot();
    let r = cli(root, 'gate', 'P0', 'passed', '--evidence', 'npm test: exit=0');
    assert.equal(r.code, EXIT.VALIDATION);
    assert.match(r.stderr, /tasks not completed/);
    completeAllP0(root);
    r = cli(root, 'gate', 'P0', 'passed', '--evidence', 'npm test: exit=0');
    assert.equal(r.code, EXIT.VALIDATION);
    assert.match(r.stderr, /PHASE_REVIEWS\/P0\.md is missing/);
    fs.mkdirSync(path.join(root, 'docs/PHASE_REVIEWS'));
    fs.writeFileSync(path.join(root, 'docs/PHASE_REVIEWS/P0.md'), '# Phase P0 Review\n');
    // A hand-edited status file must block the gate.
    fs.appendFileSync(path.join(root, 'docs/PROJECT_STATUS.md'), 'tampered\n');
    r = cli(root, 'gate', 'P0', 'passed', '--evidence', 'docs/PHASE_REVIEWS/P0.md');
    assert.equal(r.code, EXIT.VALIDATION);
    assert.match(r.stderr, /out of sync/);
    ok(root, 'render');
    ok(root, 'gate', 'P0', 'passed', '--evidence', 'docs/PHASE_REVIEWS/P0.md');
    const p0 = state(root).phases.P0;
    assert.equal(p0.status, 'completed');
    assert.equal(p0.gate, 'passed');
    assert.ok(p0.completedAt);
    assert.equal(state(root).activePhase, 'P0', 'gate must not auto-advance to the next phase');
    assert.match(read(root, 'docs/PROJECT_STATUS.md'), /Latest gate decision: P0 passed/);
    assert.equal(cli(root, 'gate', 'P0', 'failed', '--reason', 'x').code, EXIT.VALIDATION);
    ok(root, 'check');
    ok(root, 'start', 'P1', 'P1-T01');
    assert.equal(state(root).activePhase, 'P1');
  });

  test('failed/blocked gates need a reason and are recorded', () => {
    const root = makeRoot();
    assert.equal(cli(root, 'gate', 'P0', 'failed').code, EXIT.USAGE);
    assert.equal(cli(root, 'gate', 'P0', 'maybe').code, EXIT.USAGE);
    ok(root, 'gate', 'P0', 'blocked', '--reason', 'Claude CLI missing');
    const p0 = state(root).phases.P0;
    assert.equal(p0.gate, 'blocked');
    assert.equal(p0.status, 'blocked');
    assert.equal(p0.gateEvidence[0].text, 'Claude CLI missing');
    ok(root, 'check');
  });
});

describe('render and check', () => {
  test('render is idempotent and repairs a hand-edited status file', () => {
    const root = makeRoot();
    ok(root, 'start', 'P0', 'P0-T01');
    const first = read(root, 'docs/PROJECT_STATUS.md');
    assert.match(ok(root, 'render').stdout, /unchanged/);
    assert.equal(read(root, 'docs/PROJECT_STATUS.md'), first);
    fs.writeFileSync(
      path.join(root, 'docs/PROJECT_STATUS.md'),
      first.replace('in_progress', 'completed'),
    );
    const r = cli(root, 'check');
    assert.equal(r.code, EXIT.VALIDATION);
    assert.match(r.stderr, /out of sync/);
    assert.match(ok(root, 'render').stdout, /updated/);
    assert.equal(read(root, 'docs/PROJECT_STATUS.md'), first);
    ok(root, 'check');
  });

  test('renderStatus is a pure function of state', () => {
    const root = makeRoot();
    const s = state(root);
    assert.equal(renderStatus(s), renderStatus(structuredClone(s)));
    assert.equal(renderStatus(s), read(root, 'docs/PROJECT_STATUS.md'));
  });

  test('check tolerates CRLF line endings (git autocrlf on Windows)', () => {
    const root = makeRoot();
    const file = path.join(root, 'docs/PROJECT_STATUS.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    ok(root, 'check');
  });

  test('check detects semantic inconsistencies in a hand-edited state', () => {
    const root = makeRoot();
    const s = state(root);
    s.phases.P0.tasks['P0-T01'].status = 'completed'; // no evidence, no timestamps
    s.phases.P2.tasks['P2-T01'].status = 'blocked'; // no blocker, phase jump
    s.phases.P3.tasks['P3-T99'] = { ...s.phases.P3.tasks['P3-T01'] }; // not in roadmap
    writeState(root, s);
    const r = cli(root, 'check');
    assert.equal(r.code, EXIT.VALIDATION);
    for (const msg of [
      /P0-T01: completed without evidence/,
      /P2-T01: blocked without an open blocker/,
      /P2: has activity but previous phase P1 gate is pending/,
      /task P3-T99 is not in the roadmap/,
      /out of sync/,
    ]) {
      assert.match(r.stderr, msg);
    }
  });
});

describe('corruption, locking and resume', () => {
  test('corrupt JSON is reported with exit 3 and never overwritten', () => {
    const root = makeRoot();
    const file = path.join(root, 'planning/progress.json');
    fs.writeFileSync(file, '{"schemaVersion": 1, "phases": {');
    for (const args of [['check'], ['init'], ['start', 'P0', 'P0-T01'], ['render'], ['summary']]) {
      const r = cli(root, ...args);
      assert.equal(r.code, EXIT.STATE, args.join(' '));
      assert.match(r.stderr, /corrupt/);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), '{"schemaVersion": 1, "phases": {');
  });

  test('schema violations and unsupported schemaVersion are rejected', () => {
    const root = makeRoot();
    const s = state(root);
    s.phases.P0.tasks['P0-T01'].status = 'done';
    writeState(root, s);
    let r = cli(root, 'start', 'P0', 'P0-T02');
    assert.equal(r.code, EXIT.STATE);
    assert.match(r.stderr, /P0-T01\.status invalid/);
    s.phases.P0.tasks['P0-T01'].status = 'not_started';
    s.schemaVersion = 99;
    writeState(root, s);
    r = cli(root, 'check');
    assert.equal(r.code, EXIT.STATE);
    assert.match(r.stderr, /schemaVersion must be 1/);
  });

  test('missing state asks for init', () => {
    const root = makeRoot(false);
    const r = cli(root, 'summary');
    assert.equal(r.code, EXIT.STATE);
    assert.match(r.stderr, /run "node scripts\/progress\.mjs init"/);
  });

  test('a live lock blocks writers; a stale lock is reclaimed', () => {
    const root = makeRoot();
    const lock = path.join(root, 'planning/.progress.lock');
    fs.writeFileSync(lock, '{}');
    const r = cli(root, 'start', 'P0', 'P0-T01');
    assert.equal(r.code, EXIT.STATE);
    assert.match(r.stderr, /locked/);
    assert.equal(state(root).phases.P0.tasks['P0-T01'].status, 'not_started');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    ok(root, 'start', 'P0', 'P0-T01');
    assert.equal(fs.existsSync(lock), false);
    assert.equal(
      fs.readdirSync(path.join(root, 'planning')).filter((f) => f.endsWith('.tmp')).length,
      0,
    );
  });

  test('a new process resumes from files: summary reflects prior session work', () => {
    const root = makeRoot();
    ok(root, 'start', 'P0', 'P0-T01');
    ok(root, 'complete', 'P0', 'P0-T01', '--evidence', 'node --version: exit=0');
    ok(root, 'start', 'P0', 'P0-T02');
    const rev = state(root).revision;
    const summary = ok(root, 'summary').stdout;
    assert.match(summary, /Tasks: 1\/62 completed \(1\.6%\)/);
    assert.match(summary, /In progress: P0-T02/);
    assert.match(summary, new RegExp(`revision ${rev}`));
    ok(root, 'complete', 'P0', 'P0-T02', '--evidence', 'npm install: exit=0');
    assert.equal(state(root).revision, rev + 1);
  });
});

describe('historical import (--at) and usage errors', () => {
  test('--at keeps original timestamps and tags the worklog entry', () => {
    const root = makeRoot();
    ok(root, 'start', 'P0', 'P0-T01', '--at', '2026-01-01T00:00:00Z');
    ok(
      root,
      'complete',
      'P0',
      'P0-T01',
      '--at',
      '2026-01-01T00:05:00Z',
      '--evidence',
      'git --version: exit=0',
    );
    const t = state(root).phases.P0.tasks['P0-T01'];
    assert.equal(t.startedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(t.completedAt, '2026-01-01T00:05:00.000Z');
    assert.match(
      read(root, 'docs/WORKLOG.md'),
      /- 2026-01-01T00:00:00\.000Z \| P0 \| P0-T01 \| start \| in_progress \| imported/,
    );
  });

  test('--at rejects invalid, future and out-of-order timestamps', () => {
    const root = makeRoot();
    assert.equal(cli(root, 'start', 'P0', 'P0-T01', '--at', 'yesterday').code, EXIT.USAGE);
    assert.equal(
      cli(root, 'start', 'P0', 'P0-T01', '--at', '2999-01-01T00:00:00Z').code,
      EXIT.VALIDATION,
    );
    ok(root, 'start', 'P0', 'P0-T01', '--at', '2026-01-02T00:00:00Z');
    const r = cli(
      root,
      'complete',
      'P0',
      'P0-T01',
      '--at',
      '2026-01-01T00:00:00Z',
      '--evidence',
      'git --version: exit=0',
    );
    assert.equal(r.code, EXIT.VALIDATION);
    assert.match(r.stderr, /before startedAt/);
  });

  test('usage errors exit 2', () => {
    const root = makeRoot();
    for (const args of [
      [],
      ['bogus'],
      ['start', 'X1', 'P0-T01'],
      ['start', 'P0', 'P1-T01'],
      ['check', '--nope'],
      ['check', 'extra'],
    ]) {
      assert.equal(cli(root, ...args).code, EXIT.USAGE, args.join(' '));
    }
    assert.equal(cli(root, '--help').code, EXIT.OK);
  });
});
