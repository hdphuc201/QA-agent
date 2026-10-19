#!/usr/bin/env node
// QA Agent progress CLI — the only supported writer of planning/progress.json.
// Renders docs/PROJECT_STATUS.md and appends docs/WORKLOG.md after every valid update.
// Dependency-free on purpose: it must work before `npm install` and on Windows/Linux/macOS.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** @typedef {'not_started' | 'in_progress' | 'completed' | 'blocked'} Status */
/** @typedef {'pending' | 'passed' | 'failed' | 'blocked'} Gate */
/** @typedef {{ at: string, text: string }} Evidence */
/** @typedef {{ at: string, reason: string, resolvedAt: string | null }} Blocker */
/** @typedef {{ at: string, decision: Gate, text: string }} GateRecord */
/**
 * @typedef {{
 *   title: string, status: Status, evidence: Evidence[], blockers: Blocker[],
 *   startedAt: string | null, completedAt: string | null
 * }} Task
 */
/**
 * @typedef {{
 *   title: string, status: Status, gate: Gate, gateEvidence: GateRecord[],
 *   startedAt: string | null, completedAt: string | null, tasks: Record<string, Task>
 * }} Phase
 */
/**
 * @typedef {{
 *   schemaVersion: number, project: string, activePhase: string,
 *   updatedAt: string | null, revision: number, phases: Record<string, Phase>
 * }} State
 */
/** @typedef {{ at: string, phase: string, task: string, action: string, outcome: string, detail?: string, imported?: boolean }} LogEvent */
/** @typedef {{ phases: Record<string, { title: string, tasks: Record<string, string> }> }} Inventory */

export const SCHEMA_VERSION = 1;
export const EXIT = { OK: 0, VALIDATION: 1, USAGE: 2, STATE: 3 };
export const STATUSES = /** @type {const} */ ([
  'not_started',
  'in_progress',
  'completed',
  'blocked',
]);
export const GATES = /** @type {const} */ (['pending', 'passed', 'failed', 'blocked']);

const FILES = {
  state: 'planning/progress.json',
  lock: 'planning/.progress.lock',
  status: 'docs/PROJECT_STATUS.md',
  worklog: 'docs/WORKLOG.md',
  roadmap: 'QA_AGENT_MASTER_ROADMAP.md',
  reviews: 'docs/PHASE_REVIEWS',
};
const LOCK_STALE_MS = 30_000;
const PHASE_ID = /^P\d$/;
const TASK_ID = /^P\d-T\d{2}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const USAGE = `Usage: node scripts/progress.mjs <command> [args] [--root <dir>]

Commands:
  init                                   create/merge state from the roadmap task inventory (idempotent)
  start <phase> <task> [--at <iso>]       not_started|blocked -> in_progress
  complete <phase> <task> --evidence <e>  in_progress -> completed (repeat --evidence; needs exit=<n> or an existing path)
  block <phase> <task> --reason <r>       not_started|in_progress -> blocked
  gate <phase> passed --evidence <e>      requires all tasks completed, docs/PHASE_REVIEWS/<phase>.md and a clean check
  gate <phase> failed|blocked --reason <r>
  note <phase> [task] --message <m>       append a decision/note to docs/WORKLOG.md
  render                                 re-render docs/PROJECT_STATUS.md
  check                                  validate schema, inventory, transitions and status sync
  summary                                print real progress

Exit codes: 0 ok, 1 validation/check failure, 2 usage error, 3 state/IO error (corrupt, locked, missing).`;

export class CliError extends Error {
  /** @param {string} message @param {number} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- inventory

/** Parse phases (`### Px — Title`) and tasks (`- [ ] **Px-Tyy** — Title`) from the roadmap. */
/** @param {string} markdown @returns {Inventory} */
export function parseRoadmap(markdown) {
  /** @type {Inventory} */
  const inventory = { phases: {} };
  /** @type {string | null} */
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const phase = /^### (P\d) — (.+)$/.exec(line);
    if (phase?.[1] && phase[2]) {
      current = phase[1];
      inventory.phases[current] = {
        title: phase[2].replace(/\s*\[[^\]]*\]\s*$/, '').trim(),
        tasks: {},
      };
      continue;
    }
    const task = /^- \[[ xX]\] \*\*(P\d-T\d{2})\*\* — (.+)$/.exec(line);
    const target = current ? inventory.phases[current] : undefined;
    if (task?.[1] && task[2] && target) {
      if (!task[1].startsWith(`${current}-`)) continue;
      target.tasks[task[1]] = task[2].trim();
    }
  }
  return inventory;
}

/** @param {string} root @returns {Inventory} */
function loadInventory(root) {
  const file = path.join(root, FILES.roadmap);
  if (!fs.existsSync(file)) throw new CliError(`Roadmap not found: ${FILES.roadmap}`, EXIT.STATE);
  const inventory = parseRoadmap(fs.readFileSync(file, 'utf8'));
  if (Object.keys(inventory.phases).length === 0) {
    throw new CliError(`No phases found in ${FILES.roadmap}`, EXIT.STATE);
  }
  return inventory;
}

// ---------------------------------------------------------------- schema

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const isIso = (v) => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
/** @param {unknown} v */
const isIsoOrNull = (v) => v === null || isIso(v);
/** @param {unknown} v */
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

/** Structural validation. Returns a list of errors (empty = valid). */
/** @param {unknown} state @returns {string[]} */
export function validateSchema(state) {
  /** @type {string[]} */
  const errors = [];
  if (!isObject(state)) return ['state must be a JSON object'];
  if (state.schemaVersion !== SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${SCHEMA_VERSION} (got ${JSON.stringify(state.schemaVersion)})`,
    );
  }
  if (!isText(state.project)) errors.push('project must be a non-empty string');
  if (typeof state.activePhase !== 'string' || !PHASE_ID.test(state.activePhase)) {
    errors.push('activePhase must match Px');
  }
  if (!isIsoOrNull(state.updatedAt)) errors.push('updatedAt must be an ISO UTC timestamp or null');
  if (!Number.isInteger(state.revision) || /** @type {number} */ (state.revision) < 0) {
    errors.push('revision must be a non-negative integer');
  }
  if (!isObject(state.phases)) return [...errors, 'phases must be an object'];
  for (const [pid, phase] of Object.entries(state.phases)) {
    const at = `phases.${pid}`;
    if (!PHASE_ID.test(pid)) errors.push(`${at}: invalid phase id`);
    if (!isObject(phase)) {
      errors.push(`${at}: must be an object`);
      continue;
    }
    if (!isText(phase.title)) errors.push(`${at}.title must be a non-empty string`);
    if (!STATUSES.includes(/** @type {Status} */ (phase.status)))
      errors.push(`${at}.status invalid`);
    if (!GATES.includes(/** @type {Gate} */ (phase.gate))) errors.push(`${at}.gate invalid`);
    if (!isIsoOrNull(phase.startedAt)) errors.push(`${at}.startedAt invalid`);
    if (!isIsoOrNull(phase.completedAt)) errors.push(`${at}.completedAt invalid`);
    if (!Array.isArray(phase.gateEvidence)) errors.push(`${at}.gateEvidence must be an array`);
    else
      phase.gateEvidence.forEach((g, i) => {
        if (
          !isObject(g) ||
          !isIso(g.at) ||
          !GATES.includes(/** @type {Gate} */ (g.decision)) ||
          !isText(g.text)
        ) {
          errors.push(`${at}.gateEvidence[${i}] must be {at, decision, text}`);
        }
      });
    if (!isObject(phase.tasks)) {
      errors.push(`${at}.tasks must be an object`);
      continue;
    }
    for (const [tid, task] of Object.entries(phase.tasks)) {
      const tat = `${at}.tasks.${tid}`;
      if (!TASK_ID.test(tid) || !tid.startsWith(`${pid}-`)) errors.push(`${tat}: invalid task id`);
      if (!isObject(task)) {
        errors.push(`${tat}: must be an object`);
        continue;
      }
      if (!isText(task.title)) errors.push(`${tat}.title must be a non-empty string`);
      if (!STATUSES.includes(/** @type {Status} */ (task.status)))
        errors.push(`${tat}.status invalid`);
      if (!isIsoOrNull(task.startedAt)) errors.push(`${tat}.startedAt invalid`);
      if (!isIsoOrNull(task.completedAt)) errors.push(`${tat}.completedAt invalid`);
      if (!Array.isArray(task.evidence)) errors.push(`${tat}.evidence must be an array`);
      else
        task.evidence.forEach((e, i) => {
          if (!isObject(e) || !isIso(e.at) || !isText(e.text)) {
            errors.push(`${tat}.evidence[${i}] must be {at, text}`);
          }
        });
      if (!Array.isArray(task.blockers)) errors.push(`${tat}.blockers must be an array`);
      else
        task.blockers.forEach((b, i) => {
          if (!isObject(b) || !isIso(b.at) || !isText(b.reason) || !isIsoOrNull(b.resolvedAt)) {
            errors.push(`${tat}.blockers[${i}] must be {at, reason, resolvedAt}`);
          }
        });
    }
  }
  return errors;
}

// ---------------------------------------------------------------- fs helpers

/** @param {number} ms */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write via temp file + rename so readers never see a half-written file. */
/** @param {string} file @param {string} content */
export function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      // Windows may briefly hold the target open (editor, antivirus): retry a few times.
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        sleep(50 * (attempt + 1));
        continue;
      }
      fs.rmSync(tmp, { force: true });
      throw new CliError(`Failed to write ${file}: ${String(err)}`, EXIT.STATE);
    }
  }
}

/** Exclusive lock for read-modify-write cycles; stale locks (crashed process) are reclaimed. */
/** @template T @param {string} root @param {() => T} fn @returns {T} */
function withLock(root, fn) {
  const lock = path.join(root, FILES.lock);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  /** @type {number | undefined} */
  let fd;
  for (let attempt = 0; fd === undefined; attempt++) {
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (age > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      else if (attempt < 20) sleep(100);
      else throw new CliError(`State is locked by another process (${FILES.lock})`, EXIT.STATE);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

/** @param {string} root @returns {State} */
function loadState(root) {
  const file = path.join(root, FILES.state);
  if (!fs.existsSync(file)) {
    throw new CliError(
      `${FILES.state} not found — run "node scripts/progress.mjs init"`,
      EXIT.STATE,
    );
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(
      `${FILES.state} is corrupt (invalid JSON): ${String(err)}. Restore it from git; it was not modified.`,
      EXIT.STATE,
    );
  }
  const errors = validateSchema(parsed);
  if (errors.length > 0) {
    throw new CliError(
      `${FILES.state} failed schema validation:\n  - ${errors.join('\n  - ')}`,
      EXIT.STATE,
    );
  }
  return /** @type {State} */ (parsed);
}

// ---------------------------------------------------------------- rendering

/** @param {string} s */
const cell = (s) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

/** @param {State} state */
function counts(state) {
  const tasks = Object.values(state.phases).flatMap((p) => Object.entries(p.tasks));
  const done = tasks.filter(([, t]) => t.status === 'completed').length;
  return {
    tasks,
    total: tasks.length,
    done,
    percent: tasks.length === 0 ? '0.0' : ((done / tasks.length) * 100).toFixed(1),
    inProgress: tasks.filter(([, t]) => t.status === 'in_progress'),
    blocked: tasks.filter(([, t]) => t.status === 'blocked'),
  };
}

/** @param {State} state @returns {(GateRecord & { phase: string }) | undefined} */
function latestGate(state) {
  return Object.entries(state.phases)
    .flatMap(([phase, p]) => p.gateEvidence.map((g) => ({ ...g, phase })))
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
}

/** @param {Task} task */
const openBlockers = (task) => task.blockers.filter((b) => b.resolvedAt === null);

/** Deterministic Markdown dashboard (no wall-clock values, so render is idempotent). */
/** @param {State} state @returns {string} */
export function renderStatus(state) {
  const c = counts(state);
  const active = state.phases[state.activePhase];
  const gate = latestGate(state);
  const lines = [
    '<!-- AUTO-GENERATED by scripts/progress.mjs from planning/progress.json. Do not edit by hand. -->',
    '',
    '# QA Agent — Project Status',
    '',
    `- State revision: ${state.revision}`,
    `- Last update: ${state.updatedAt ?? '—'}`,
    `- Active phase: ${state.activePhase}${active ? ` — ${active.title}` : ''}`,
    `- Task progress: ${c.done}/${c.total} completed (${c.percent}%) — share of roadmap tasks, not test coverage`,
    `- In progress: ${c.inProgress.length} · Blocked: ${c.blocked.length}`,
    `- Latest gate decision: ${gate ? `${gate.phase} ${gate.decision} at ${gate.at} — ${cell(gate.text)}` : '—'}`,
    '',
    '## Phases',
    '',
    '| Phase | Title | Status | Gate | Tasks done |',
    '|---|---|---|---|---|',
  ];
  for (const [pid, p] of Object.entries(state.phases)) {
    const tasks = Object.values(p.tasks);
    const done = tasks.filter((t) => t.status === 'completed').length;
    lines.push(`| ${pid} | ${cell(p.title)} | ${p.status} | ${p.gate} | ${done}/${tasks.length} |`);
  }
  lines.push('', '## In progress', '');
  if (c.inProgress.length === 0) lines.push('_None_');
  for (const [tid, t] of c.inProgress)
    lines.push(`- ${tid} — ${cell(t.title)} (since ${t.startedAt ?? '—'})`);
  lines.push('', '## Blocked', '');
  if (c.blocked.length === 0) lines.push('_None_');
  for (const [tid, t] of c.blocked) {
    for (const b of openBlockers(t)) lines.push(`- ${tid} — ${cell(b.reason)} (since ${b.at})`);
  }
  lines.push('', '## Tasks', '');
  for (const [pid, p] of Object.entries(state.phases)) {
    lines.push(
      `### ${pid} — ${cell(p.title)}`,
      '',
      '| Task | Status | Title | Evidence |',
      '|---|---|---|---|',
    );
    for (const [tid, t] of Object.entries(p.tasks)) {
      const ev = t.evidence.map((e) => cell(e.text)).join('<br>') || '—';
      lines.push(`| ${tid} | ${t.status} | ${cell(t.title)} | ${ev} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const WORKLOG_HEADER = `# QA Agent — Work Log

Append-only. Never delete or rewrite entries. Lines are written by \`scripts/progress.mjs\`
(format: \`- <ISO time> | <phase> | <task> | <action> | <outcome> | <detail>\`).
Imported entries keep their original timestamp and are tagged \`imported\`.
`;

/** @param {string} root @param {LogEvent[]} events @param {string} now */
function appendWorklog(root, events, now) {
  const file = path.join(root, FILES.worklog);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${WORKLOG_HEADER}\n`);
  const text = events
    .map((e) => {
      const parts = [e.at, e.phase, e.task || '-', e.action, e.outcome];
      if (e.detail) parts.push(cell(e.detail));
      if (e.imported) parts.push(`imported (recorded ${now})`);
      return `- ${parts.join(' | ')}\n`;
    })
    .join('');
  if (text) fs.appendFileSync(file, text);
}

/** @param {string} root @param {State} state @returns {boolean} true when the file changed */
function writeStatus(root, state) {
  const file = path.join(root, FILES.status);
  const next = renderStatus(state);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
  if (current === next) return false;
  writeAtomic(file, next);
  return true;
}

// ---------------------------------------------------------------- domain rules

/** @param {Phase} phase @returns {Status} */
export function derivePhaseStatus(phase) {
  if (phase.gate === 'passed') return 'completed';
  if (phase.gate === 'blocked') return 'blocked';
  return Object.values(phase.tasks).some((t) => t.status !== 'not_started')
    ? 'in_progress'
    : 'not_started';
}

/**
 * Evidence must be concrete: contain an exit code (`exit=0`) or reference at least one existing
 * file. Every path-like token must exist inside the repository root.
 * @param {string} text @param {string} root @returns {string | null} error message or null
 */
export function evidenceError(text, root) {
  const trimmed = text.trim();
  if (trimmed.length < 10) return `evidence too short to be verifiable: "${trimmed}"`;
  const hasExit = /\bexit(?:\s*code)?\s*[=:]\s*-?\d+\b/i.test(trimmed);
  const tokens = trimmed
    .split(/\s+/)
    .map((t) => t.replace(/^[("'`[]+|[)"'`\],;:.]+$/g, ''))
    .filter((t) => !t.includes('*') && !t.includes('://'))
    .filter(
      (t) =>
        /^[\w.-]+(?:[\\/][\w.-]+)+\/?$/.test(t) &&
        (/\.[A-Za-z0-9]{1,8}$/.test(t) || t.endsWith('/')),
    );
  let existing = 0;
  for (const token of tokens) {
    const abs = path.resolve(root, token);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel))
      return `evidence path escapes repository root: ${token}`;
    if (!fs.existsSync(abs)) return `evidence references a missing file: ${token}`;
    existing++;
  }
  if (!hasExit && existing === 0) {
    return 'evidence must include an exit code (e.g. "npm test: exit=0") or an existing file path';
  }
  return null;
}

/** @param {State} state @param {string} pid @param {string} tid */
function getTask(state, pid, tid) {
  const phase = getPhase(state, pid);
  const task = phase.tasks[tid];
  if (!task) throw new CliError(`Unknown task ${tid} in phase ${pid}`, EXIT.VALIDATION);
  return { phase, task };
}

/** @param {State} state @param {string} pid */
function getPhase(state, pid) {
  const phase = state.phases[pid];
  if (!phase) throw new CliError(`Unknown phase ${pid}`, EXIT.VALIDATION);
  return phase;
}

/** @param {State} state @param {string} pid @returns {string | null} */
function previousPhaseId(state, pid) {
  const ids = Object.keys(state.phases);
  const i = ids.indexOf(pid);
  return i > 0 ? (ids[i - 1] ?? null) : null;
}

/** @param {string | undefined} at @returns {{ at: string, imported: boolean }} */
function resolveTime(at) {
  const now = new Date();
  if (at === undefined) return { at: now.toISOString(), imported: false };
  if (!isIso(at)) throw new CliError(`--at must be an ISO UTC timestamp (got "${at}")`, EXIT.USAGE);
  if (Date.parse(at) > now.getTime() + 60_000)
    throw new CliError('--at cannot be in the future', EXIT.VALIDATION);
  return { at: new Date(at).toISOString(), imported: true };
}

/** Consistency checks beyond the schema. */
/** @param {string} root @param {State} state @returns {string[]} */
export function checkState(root, state) {
  const errors = validateSchema(state);
  if (errors.length > 0) return errors;
  try {
    const inventory = loadInventory(root);
    for (const [pid, p] of Object.entries(inventory.phases)) {
      const phase = state.phases[pid];
      if (!phase) {
        errors.push(`inventory: phase ${pid} missing from state (run init)`);
        continue;
      }
      for (const tid of Object.keys(p.tasks)) {
        if (!phase.tasks[tid]) errors.push(`inventory: task ${tid} missing from state (run init)`);
      }
    }
    for (const [pid, phase] of Object.entries(state.phases)) {
      const known = inventory.phases[pid];
      if (!known) errors.push(`inventory: phase ${pid} is not in the roadmap`);
      for (const tid of Object.keys(phase.tasks)) {
        if (known && !(tid in known.tasks))
          errors.push(`inventory: task ${tid} is not in the roadmap`);
      }
    }
    for (const n of ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9']) {
      if (!inventory.phases[n]) errors.push(`inventory: roadmap is missing phase ${n}`);
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  if (!state.phases[state.activePhase])
    errors.push(`activePhase ${state.activePhase} does not exist`);
  for (const [pid, phase] of Object.entries(state.phases)) {
    for (const [tid, t] of Object.entries(phase.tasks)) {
      const open = openBlockers(t).length;
      if (t.status === 'completed') {
        if (t.evidence.length === 0) errors.push(`${tid}: completed without evidence`);
        if (!t.startedAt || !t.completedAt)
          errors.push(`${tid}: completed without startedAt/completedAt`);
        else if (t.completedAt < t.startedAt)
          errors.push(`${tid}: completedAt is before startedAt`);
      } else if (t.completedAt) errors.push(`${tid}: completedAt set but status is ${t.status}`);
      if (t.status === 'in_progress' && !t.startedAt)
        errors.push(`${tid}: in_progress without startedAt`);
      if (t.status === 'blocked' && open === 0)
        errors.push(`${tid}: blocked without an open blocker`);
      if (t.status !== 'blocked' && open > 0)
        errors.push(`${tid}: has open blockers but status is ${t.status}`);
      if (t.status === 'not_started' && (t.startedAt || t.evidence.length > 0)) {
        errors.push(`${tid}: not_started but has startedAt/evidence`);
      }
    }
    const derived = derivePhaseStatus(phase);
    if (phase.status !== derived)
      errors.push(`${pid}: status ${phase.status} but tasks/gate imply ${derived}`);
    const last = phase.gateEvidence.at(-1);
    if (phase.gate !== 'pending' && last?.decision !== phase.gate) {
      errors.push(`${pid}: gate ${phase.gate} has no matching gateEvidence record`);
    }
    if (phase.gate === 'passed') {
      const pending = Object.entries(phase.tasks).filter(([, t]) => t.status !== 'completed');
      if (pending.length > 0)
        errors.push(
          `${pid}: gate passed but tasks not completed: ${pending.map(([id]) => id).join(', ')}`,
        );
      if (!fs.existsSync(path.join(root, FILES.reviews, `${pid}.md`))) {
        errors.push(`${pid}: gate passed but ${FILES.reviews}/${pid}.md is missing`);
      }
      if (!phase.completedAt) errors.push(`${pid}: gate passed without completedAt`);
    }
    const prev = previousPhaseId(state, pid);
    const prevPhase = prev ? state.phases[prev] : undefined;
    if (prevPhase && derived !== 'not_started' && prevPhase.gate !== 'passed') {
      errors.push(`${pid}: has activity but previous phase ${prev} gate is ${prevPhase.gate}`);
    }
  }
  const statusFile = path.join(root, FILES.status);
  if (!fs.existsSync(statusFile)) errors.push(`${FILES.status} is missing (run render)`);
  else if (fs.readFileSync(statusFile, 'utf8').replace(/\r\n/g, '\n') !== renderStatus(state)) {
    errors.push(
      `${FILES.status} is out of sync with ${FILES.state} (run render; never edit it by hand)`,
    );
  }
  if (!fs.existsSync(path.join(root, FILES.worklog))) errors.push(`${FILES.worklog} is missing`);
  return errors;
}

// ---------------------------------------------------------------- commands

/**
 * Locked read-modify-write: validates, bumps revision, writes atomically, renders, logs.
 * @param {string} root @param {(state: State) => LogEvent[]} mutate
 */
function update(root, mutate) {
  return withLock(root, () => {
    const state = loadState(root);
    const events = mutate(state);
    for (const phase of Object.values(state.phases)) phase.status = derivePhaseStatus(phase);
    const now = new Date().toISOString();
    state.revision += 1;
    state.updatedAt = now;
    const errors = validateSchema(state);
    if (errors.length > 0)
      throw new CliError(
        `Refusing to write invalid state:\n  - ${errors.join('\n  - ')}`,
        EXIT.STATE,
      );
    writeAtomic(path.join(root, FILES.state), `${JSON.stringify(state, null, 2)}\n`);
    writeStatus(root, state);
    appendWorklog(root, events, now);
    return state;
  });
}

/** @param {string} root @param {(s: string) => void} out */
function cmdInit(root, out) {
  withLock(root, () => {
    const inventory = loadInventory(root);
    const file = path.join(root, FILES.state);
    const exists = fs.existsSync(file);
    /** @type {State} */
    const state = exists
      ? loadState(root)
      : {
          schemaVersion: SCHEMA_VERSION,
          project: 'qa-agent',
          activePhase: 'P0',
          updatedAt: null,
          revision: 0,
          phases: {},
        };
    let added = 0;
    for (const [pid, p] of Object.entries(inventory.phases)) {
      let phase = state.phases[pid];
      if (!phase) {
        phase = {
          title: p.title,
          status: 'not_started',
          gate: 'pending',
          gateEvidence: [],
          startedAt: null,
          completedAt: null,
          tasks: {},
        };
        state.phases[pid] = phase;
      }
      for (const [tid, title] of Object.entries(p.tasks)) {
        if (phase.tasks[tid]) continue;
        phase.tasks[tid] = {
          title,
          status: 'not_started',
          evidence: [],
          blockers: [],
          startedAt: null,
          completedAt: null,
        };
        added++;
      }
    }
    const now = new Date().toISOString();
    if (!exists || added > 0) {
      state.revision += 1;
      state.updatedAt = now;
      writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
      appendWorklog(
        root,
        [
          {
            at: now,
            phase: '-',
            task: '-',
            action: 'init',
            outcome: exists ? 'merged' : 'created',
            detail: `${added} task(s) added from roadmap`,
          },
        ],
        now,
      );
    } else if (!fs.existsSync(path.join(root, FILES.worklog))) {
      appendWorklog(root, [], now);
    }
    writeStatus(root, state);
    out(
      exists
        ? `init: state exists, ${added} missing task(s) added`
        : `init: created ${FILES.state} with ${added} task(s)`,
    );
  });
}

/** @param {string} root @param {string} pid @param {string} tid @param {string | undefined} atArg */
function cmdStart(root, pid, tid, atArg) {
  const { at, imported } = resolveTime(atArg);
  return update(root, (state) => {
    const { phase, task } = getTask(state, pid, tid);
    if (task.status !== 'not_started' && task.status !== 'blocked') {
      throw new CliError(
        `Invalid transition for ${tid}: ${task.status} -> in_progress`,
        EXIT.VALIDATION,
      );
    }
    const prev = previousPhaseId(state, pid);
    const prevPhase = prev ? state.phases[prev] : undefined;
    if (prevPhase && prevPhase.gate !== 'passed') {
      throw new CliError(
        `Cannot start ${tid}: previous phase ${prev} gate is ${prevPhase.gate}, not passed`,
        EXIT.VALIDATION,
      );
    }
    const resumed = task.status === 'blocked';
    for (const b of openBlockers(task)) b.resolvedAt = at;
    task.status = 'in_progress';
    task.startedAt ??= at;
    phase.startedAt ??= at;
    state.activePhase = pid;
    return [
      {
        at,
        phase: pid,
        task: tid,
        action: resumed ? 'unblock' : 'start',
        outcome: 'in_progress',
        imported,
      },
    ];
  });
}

/** @param {string} root @param {string} pid @param {string} tid @param {string[]} evidence @param {string | undefined} atArg */
function cmdComplete(root, pid, tid, evidence, atArg) {
  if (evidence.length === 0)
    throw new CliError('complete requires at least one --evidence', EXIT.USAGE);
  for (const e of evidence) {
    const err = evidenceError(e, root);
    if (err) throw new CliError(err, EXIT.VALIDATION);
  }
  const { at, imported } = resolveTime(atArg);
  return update(root, (state) => {
    const { task } = getTask(state, pid, tid);
    if (task.status !== 'in_progress') {
      throw new CliError(
        `Invalid transition for ${tid}: ${task.status} -> completed (start it first)`,
        EXIT.VALIDATION,
      );
    }
    if (task.startedAt && at < task.startedAt)
      throw new CliError(`--at ${at} is before startedAt ${task.startedAt}`, EXIT.VALIDATION);
    task.status = 'completed';
    task.completedAt = at;
    task.evidence.push(...evidence.map((text) => ({ at, text: text.trim() })));
    return [
      {
        at,
        phase: pid,
        task: tid,
        action: 'complete',
        outcome: 'completed',
        detail: `evidence: ${evidence.join(' ; ')}`,
        imported,
      },
    ];
  });
}

/** @param {string} root @param {string} pid @param {string} tid @param {string | undefined} reason @param {string | undefined} atArg */
function cmdBlock(root, pid, tid, reason, atArg) {
  if (!reason?.trim()) throw new CliError('block requires --reason', EXIT.USAGE);
  const { at, imported } = resolveTime(atArg);
  return update(root, (state) => {
    const { task } = getTask(state, pid, tid);
    if (task.status !== 'not_started' && task.status !== 'in_progress') {
      throw new CliError(
        `Invalid transition for ${tid}: ${task.status} -> blocked`,
        EXIT.VALIDATION,
      );
    }
    task.status = 'blocked';
    task.blockers.push({ at, reason: reason.trim(), resolvedAt: null });
    return [
      {
        at,
        phase: pid,
        task: tid,
        action: 'block',
        outcome: 'blocked',
        detail: `reason: ${reason.trim()}`,
        imported,
      },
    ];
  });
}

/** @param {string} root @param {string} pid @param {string | undefined} decision @param {string[]} evidence @param {string | undefined} reason */
function cmdGate(root, pid, decision, evidence, reason) {
  if (decision !== 'passed' && decision !== 'failed' && decision !== 'blocked') {
    throw new CliError('gate decision must be passed, failed or blocked', EXIT.USAGE);
  }
  if (decision === 'passed') {
    if (evidence.length === 0) throw new CliError('gate passed requires --evidence', EXIT.USAGE);
    for (const e of evidence) {
      const err = evidenceError(e, root);
      if (err) throw new CliError(err, EXIT.VALIDATION);
    }
  } else if (!reason?.trim()) throw new CliError(`gate ${decision} requires --reason`, EXIT.USAGE);
  const at = new Date().toISOString();
  return update(root, (state) => {
    const phase = getPhase(state, pid);
    if (phase.gate === 'passed') throw new CliError(`${pid} gate already passed`, EXIT.VALIDATION);
    if (decision === 'passed') {
      const pending = Object.entries(phase.tasks).filter(([, t]) => t.status !== 'completed');
      if (pending.length > 0) {
        throw new CliError(
          `Cannot pass ${pid}: tasks not completed: ${pending.map(([id]) => id).join(', ')}`,
          EXIT.VALIDATION,
        );
      }
      const review = `${FILES.reviews}/${pid}.md`;
      if (!fs.existsSync(path.join(root, review)))
        throw new CliError(`Cannot pass ${pid}: ${review} is missing`, EXIT.VALIDATION);
      const errors = checkState(root, state);
      if (errors.length > 0)
        throw new CliError(
          `Cannot pass ${pid}: check failed:\n  - ${errors.join('\n  - ')}`,
          EXIT.VALIDATION,
        );
      phase.completedAt = at;
    }
    const text =
      decision === 'passed' ? evidence.join(' ; ') : /** @type {string} */ (reason).trim();
    phase.gate = decision;
    phase.gateEvidence.push({ at, decision, text });
    return [{ at, phase: pid, task: '-', action: 'gate', outcome: decision, detail: text }];
  });
}

/** @param {string} root @param {string} pid @param {string | undefined} tid @param {string | undefined} message */
function cmdNote(root, pid, tid, message) {
  if (!message?.trim()) throw new CliError('note requires --message', EXIT.USAGE);
  withLock(root, () => {
    const state = loadState(root);
    if (tid) getTask(state, pid, tid);
    else getPhase(state, pid);
    const at = new Date().toISOString();
    appendWorklog(
      root,
      [
        {
          at,
          phase: pid,
          task: tid ?? '-',
          action: 'note',
          outcome: 'logged',
          detail: message.trim(),
        },
      ],
      at,
    );
  });
}

/** @param {State} state @returns {string} */
export function formatSummary(state) {
  const c = counts(state);
  const gate = latestGate(state);
  const lines = [
    `QA Agent progress — revision ${state.revision}, updated ${state.updatedAt ?? '—'}`,
    `Tasks: ${c.done}/${c.total} completed (${c.percent}%) — task completion, not test coverage`,
    `Active phase: ${state.activePhase} — ${state.phases[state.activePhase]?.title ?? '?'}`,
    'Phases:',
    ...Object.entries(state.phases).map(([pid, p]) => {
      const t = Object.values(p.tasks);
      return `  ${pid}  ${p.status.padEnd(11)}  gate=${p.gate.padEnd(7)}  ${t.filter((x) => x.status === 'completed').length}/${t.length}`;
    }),
    `In progress: ${c.inProgress.map(([id]) => id).join(', ') || 'none'}`,
    `Blocked: ${
      c.blocked
        .map(
          ([id, t]) =>
            `${id} (${openBlockers(t)
              .map((b) => b.reason)
              .join('; ')})`,
        )
        .join(', ') || 'none'
    }`,
    `Latest gate: ${gate ? `${gate.phase} ${gate.decision} at ${gate.at} — ${gate.text}` : 'none'}`,
  ];
  return lines.join('\n');
}

/**
 * Run the CLI with the given argv (without node/script). Returns the exit code.
 * @param {string[]} argv
 * @param {{ out?: (s: string) => void, err?: (s: string) => void, root?: string }} [io]
 */
export function run(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  try {
    /** @type {ReturnType<typeof parseArgs>} */
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          root: { type: 'string' },
          evidence: { type: 'string', multiple: true },
          reason: { type: 'string' },
          message: { type: 'string' },
          at: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        },
      });
    } catch (e) {
      throw new CliError(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`, EXIT.USAGE);
    }
    const { values, positionals } = parsed;
    const [command, pid, arg] = positionals;
    if (values.help || !command) {
      out(USAGE);
      return values.help ? EXIT.OK : EXIT.USAGE;
    }
    const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : undefined);
    const evidence = Array.isArray(values.evidence) ? values.evidence.map(String) : [];
    const root = path.resolve(str(values.root) ?? io.root ?? defaultRoot());
    const need = (/** @type {number} */ n) => {
      if (positionals.length !== n)
        throw new CliError(`${command} expects ${n - 1} argument(s)\n\n${USAGE}`, EXIT.USAGE);
    };
    const requirePhase = () => {
      if (!pid || !PHASE_ID.test(pid))
        throw new CliError(`Invalid phase id "${pid ?? ''}" (expected Px)`, EXIT.USAGE);
      return pid;
    };
    const requireTask = () => {
      if (!arg || !TASK_ID.test(arg) || !arg.startsWith(`${pid}-`)) {
        throw new CliError(
          `Invalid task id "${arg ?? ''}" for phase ${pid ?? ''} (expected ${pid ?? 'Px'}-Tyy)`,
          EXIT.USAGE,
        );
      }
      return arg;
    };
    switch (command) {
      case 'init':
        need(1);
        cmdInit(root, out);
        return EXIT.OK;
      case 'start':
        need(3);
        cmdStart(root, requirePhase(), requireTask(), str(values.at));
        out(`${arg}: in_progress`);
        return EXIT.OK;
      case 'complete':
        need(3);
        cmdComplete(root, requirePhase(), requireTask(), evidence, str(values.at));
        out(`${arg}: completed`);
        return EXIT.OK;
      case 'block':
        need(3);
        cmdBlock(root, requirePhase(), requireTask(), str(values.reason), str(values.at));
        out(`${arg}: blocked`);
        return EXIT.OK;
      case 'gate':
        need(3);
        cmdGate(root, requirePhase(), arg, evidence, str(values.reason));
        out(`${pid} gate: ${arg ?? ''}`);
        return EXIT.OK;
      case 'note':
        if (positionals.length !== 2 && positionals.length !== 3) need(3);
        cmdNote(
          root,
          requirePhase(),
          positionals.length === 3 ? requireTask() : undefined,
          str(values.message),
        );
        out('note appended');
        return EXIT.OK;
      case 'render': {
        need(1);
        const changed = withLock(root, () => writeStatus(root, loadState(root)));
        out(`render: ${FILES.status} ${changed ? 'updated' : 'unchanged'}`);
        return EXIT.OK;
      }
      case 'check': {
        need(1);
        const errors = checkState(root, loadState(root));
        if (errors.length > 0) {
          err(`check FAILED (${errors.length}):\n  - ${errors.join('\n  - ')}`);
          return EXIT.VALIDATION;
        }
        out('check OK');
        return EXIT.OK;
      }
      case 'summary':
        need(1);
        out(formatSummary(loadState(root)));
        return EXIT.OK;
      default:
        throw new CliError(`Unknown command "${command}"\n\n${USAGE}`, EXIT.USAGE);
    }
  } catch (e) {
    if (e instanceof CliError) {
      err(`error: ${e.message}`);
      return e.code;
    }
    err(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return EXIT.STATE;
  }
}

function defaultRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
