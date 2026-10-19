// Controlled-language interpreter (docs/REQUIREMENTS_FORMAT.md): requirement sentences → structured
// steps and assertions. The project map only says HOW to act (which link/form/button); WHAT to
// expect comes from the sentence itself. Anything unrecognised becomes `manual` (→ NEEDS_REVIEW).

import type { ProjectMapFile } from '../discovery/discover.ts';
import type { Assertion, Step, ValueT } from './schema.ts';

export interface InterpretContext {
  map: ProjectMapFile | null;
  /** Roles named in the requirement (for "the viewer sees …"). */
  roles: string[];
}

export interface InterpretedExpected {
  before: Step[];
  asserts: Assertion[];
}

const METHOD = '(GET|POST|PUT|PATCH|DELETE)';
/** Placeholder for "the value that identifies the created record" (first unique field). */
export const RECORD_REF = 'data.*';
const ACTION_VERBS = 'signs|opens|submits|enters|clicks|tries|selects|types';

/** "<id>" placeholders → subject reference. */
const subjectPath = (p: string) => p.replace(/<\w+>|:param/g, '{{subject.id}}');

/** Split "opens the request and clicks "Approve"" into actions (only before a verb). */
export function splitActions(sentence: string): string[] {
  return sentence
    .split(new RegExp(`\\s+and\\s+(?=(?:${ACTION_VERBS})\\b)`, 'i'))
    .map((s) => s.trim());
}

/** Who performs the sentence: "the approver …", "an anonymous user …", "a requester or viewer …". */
export function sentenceActors(sentence: string, roles: string[]): string[] {
  const s = sentence.toLowerCase();
  if (/\banonymous\b/.test(s)) return ['anonymous'];
  const head = /^(?:the|an?)\s+([a-z]+(?:\s+or\s+[a-z]+)*)/.exec(s)?.[1] ?? '';
  const named = head.split(/\s+or\s+/).filter((r) => roles.includes(r));
  return named;
}

function uiRole(map: ProjectMapFile | null, name: string): 'button' | 'link' {
  const hit = map?.ui.find((u) => u.name === name);
  return hit?.role === 'link' ? 'link' : 'button';
}

interface FieldSpec {
  noun: string;
  value: ValueT;
}

/** "a title and an amount of 250" / "an empty title" / "the amount under test". */
export function parseFieldSpecs(text: string): FieldSpec[] {
  return text
    .split(/,\s*|\s+and\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): FieldSpec | null => {
      let m = /^(?:an?|the)\s+empty\s+(\w+)$/i.exec(part);
      if (m?.[1]) return { noun: m[1].toLowerCase(), value: { literal: '' } };
      m = /^(?:an?|the)\s+(\w+)\s+of\s+"?([^"]+?)"?$/i.exec(part);
      if (m?.[1] && m[2] !== undefined)
        return { noun: m[1].toLowerCase(), value: { literal: m[2] } };
      m = /^(?:an?|the)\s+(\w+)\s+under test$/i.exec(part);
      if (m?.[1])
        return { noun: m[1].toLowerCase(), value: { ref: `boundary.${m[1].toLowerCase()}` } };
      m = /^(?:an?|the)\s+(\w+)$/i.exec(part);
      if (m?.[1]) return { noun: m[1].toLowerCase(), value: { unique: m[1].toLowerCase() } };
      return null;
    })
    .filter((x): x is FieldSpec => x !== null);
}

/** Steps for `submits "<link name>" with <fields>`: open the linked form, fill, submit. */
function submitForm(
  ctx: InterpretContext,
  as: string,
  linkName: string,
  fieldsText: string,
): Step[] | null {
  const map = ctx.map;
  if (!map) return null;
  const link = map.ui.find((u) => u.role === 'link' && u.name === linkName && u.href);
  const specs = parseFieldSpecs(fieldsText);
  if (!link?.href || specs.length === 0) return null;
  const form = map.forms.find((f) =>
    specs.every((s) => f.fields.some((fl) => fl.label?.toLowerCase() === s.noun)),
  );
  const submit = form?.submit[0];
  if (!form || !submit) return null;
  const steps: Step[] = [{ do: 'goto', as, path: link.href }];
  for (const s of specs) {
    const label = form.fields.find((fl) => fl.label?.toLowerCase() === s.noun)?.label ?? s.noun;
    steps.push({ do: 'fill', as, label, value: s.value });
  }
  steps.push({ do: 'click', as, role: 'button', name: submit, capture: 'subject' });
  return steps;
}

/** One action sentence (no "and" split) → steps. */
function actionSteps(ctx: InterpretContext, as: string, action: string): Step[] {
  const a = action.replace(/^(?:the|an?)\s+(?:anonymous\s+)?[a-z]+(?:\s+or\s+[a-z]+)*\s+/i, '');
  let m: RegExpExecArray | null;
  if (/^signs in with a valid username and password$/i.test(a))
    return [{ do: 'login', as, invalidPassword: false, implicit: false }];
  if (/^signs in with a wrong password$/i.test(a))
    return [{ do: 'login', as, invalidPassword: true, implicit: false }];
  if ((m = /^opens `([^`]+)`$/i.exec(a))?.[1]) return [{ do: 'goto', as, path: m[1] }];
  if (/^(?:opens (?:the|that) \w+|tries to \w+ it)$/i.test(a))
    return [{ do: 'goto', as, path: '{{subject.path}}' }];
  if ((m = /^submits "([^"]+)" with (.+)$/i.exec(a))?.[1] && m[2]) {
    const steps = submitForm(ctx, as, m[1], m[2]);
    if (steps) return steps;
  }
  if ((m = /^enters an? (\w+)$/i.exec(a))?.[1]) {
    const noun = m[1].toLowerCase();
    return [
      {
        do: 'fill',
        as,
        label: noun.charAt(0).toUpperCase() + noun.slice(1),
        value: { unique: noun },
      },
    ];
  }
  if ((m = /^clicks "([^"]+)"$/i.exec(a))?.[1])
    return [{ do: 'click', as, role: uiRole(ctx.map, m[1]), name: m[1] }];
  return [{ do: 'manual', as, text: action }];
}

export function interpretWhen(ctx: InterpretContext, as: string, sentence: string): Step[] {
  return splitActions(sentence).flatMap((a) => actionSteps(ctx, as, a));
}

export function interpretGiven(
  as: string,
  sentence: string,
): { steps: Step[]; needsSubject: { status: string; creator: string | null } | null } {
  let m: RegExpExecArray | null;
  if ((m = /is on `([^`]+)`$/i.exec(sentence))?.[1])
    return { steps: [{ do: 'goto', as, path: m[1] }], needsSubject: null };
  if (/is signed in$/i.test(sentence)) return { steps: [], needsSubject: null }; // login is implicit per actor
  if ((m = /^an?\s+(\w+)\s+\w+(?:\s+created by the (\w+))?$/i.exec(sentence))?.[1]) {
    const status = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return { steps: [], needsSubject: { status, creator: m[2]?.toLowerCase() ?? null } };
  }
  return { steps: [{ do: 'manual', as, text: sentence }], needsSubject: null };
}

/** Which role a sentence speaks about ("the requester sees …", "for the viewer"). */
function mentionedRole(ctx: InterpretContext, s: string): string | null {
  const m = /\b(?:the|for the)\s+([a-z]+)\s+(?:sees|has|is)\b|\bfor the ([a-z]+)\b/i.exec(s);
  const role = (m?.[1] ?? m?.[2])?.toLowerCase();
  return role && ctx.roles.includes(role) ? role : null;
}

/** Expected sentence → assertions (+ navigation needed first). */
export function interpretExpected(
  ctx: InterpretContext,
  actor: string,
  sentence: string,
): InterpretedExpected {
  const before: Step[] = [];
  const asserts: Assertion[] = [];
  const s = sentence;
  let m: RegExpExecArray | null;
  let as = mentionedRole(ctx, s) ?? actor;
  if (/without a session/i.test(s)) as = 'anonymous';

  // API status: "`GET /api/x` … returns HTTP 401" or "… returns HTTP 400 from `POST /api/x`"
  const call = new RegExp(`\`${METHOD} (\\/[^\`]+)\`[^\`]*?returns HTTP (\\d{3})`).exec(s);
  const from = new RegExp(`returns HTTP (\\d{3}) from \`${METHOD} (\\/[^\`]+)\``).exec(s);
  const api = call
    ? { method: call[1], path: call[2], status: call[3] }
    : from
      ? { method: from[2], path: from[3], status: from[1] }
      : null;
  if (api?.method && api.path && api.status) {
    // "without a reason" → send that field empty; "without a session" was handled via `as`.
    const without = /without an? (\w+)/i.exec(s)?.[1]?.toLowerCase();
    asserts.push({
      kind: 'apiStatus',
      as,
      method: api.method as 'GET',
      path: subjectPath(api.path),
      status: Number(api.status),
      ...(without && without !== 'session' ? { body: { [without]: '' } } : {}),
    });
    return { before, asserts };
  }

  if ((m = /(?:redirected to|stays on|page) `([^`]+)`/i.exec(s))?.[1])
    asserts.push({ kind: 'url', as, path: m[1] });
  if ((m = /appears on [\w ]*?`([^`]+)`/i.exec(s))?.[1]) {
    before.push({ do: 'goto', as, path: m[1] });
    // The created record is recognised by its first generated value (resolved by the planner).
    asserts.push({ kind: 'text', as, value: { ref: RECORD_REF } });
  }
  if ((m = /the heading "([^"]+)"/i.exec(s))?.[1])
    asserts.push({ kind: 'heading', as, name: m[1] });
  if ((m = /the alert "([^"]+)" is shown/i.exec(s))?.[1])
    asserts.push({ kind: 'alert', as, text: m[1] });
  if ((m = /\bshows "([^"]+)"/i.exec(s))?.[1])
    asserts.push({ kind: 'text', as, value: { literal: m[1] } });
  if (
    /\bshows the (\w+)\b(?! ")/i.test(s) &&
    !/shows the status/i.test(s.split(' and ')[0] ?? '')
  ) {
    const noun = /\bshows the (\w+)\b/i.exec(s)?.[1]?.toLowerCase();
    if (noun && noun !== 'status' && noun !== 'alert' && noun !== 'heading')
      asserts.push({ kind: 'text', as, value: { ref: `data.${noun}` } });
  }
  if (
    (m = /\bthe (\w+) is shown\b/i.exec(s))?.[1] &&
    !['alert', 'heading'].includes(m[1].toLowerCase())
  ) {
    asserts.push({ kind: 'text', as, value: { ref: `data.${m[1].toLowerCase()}` } });
  }
  if ((m = /\bstatus(?: is)? "([^"]+)"/i.exec(s))?.[1]) {
    if (as !== actor || /for that \w+/i.test(s))
      before.push({ do: 'goto', as, path: '{{subject.path}}' });
    asserts.push({ kind: 'text', as, value: { literal: m[1] } });
  }
  if ((m = /\bstays "([^"]+)"/i.exec(s))?.[1]) {
    before.push({ do: 'goto', as, path: '{{subject.path}}' });
    asserts.push({ kind: 'text', as, value: { literal: m[1] } });
  }
  if ((m = /\bno "([^"]+)" (button|link)\b/i.exec(s))?.[1] && m[2]) {
    asserts.push({ kind: 'absent', as, role: m[2].toLowerCase() as 'button' | 'link', name: m[1] });
  }
  if ((m = /^no (\w+) is created$/i.exec(s))?.[1]) {
    const plural = `${m[1].toLowerCase()}s`;
    const list = ctx.map?.routes.find(
      (r) => r.method === 'GET' && r.api && r.path.split('/').at(-1) === plural,
    );
    asserts.push(
      list ? { kind: 'apiCountUnchanged', as, path: list.path } : { kind: 'manual', as, text: s },
    );
  }
  if (asserts.length === 0) asserts.push({ kind: 'manual', as, text: s });
  // "… in a second tab": same role session, another tab of its context (it starts empty).
  if (/\bin a second tab\b/i.test(s)) {
    if (!before.some((b) => b.do === 'goto'))
      before.unshift({ do: 'goto', as, path: '{{subject.path}}' });
    for (const b of before) if (b.do === 'goto' || b.do === 'fill' || b.do === 'click') b.tab = 2;
    for (const a of asserts)
      if (a.kind !== 'apiStatus' && a.kind !== 'apiCountUnchanged' && a.kind !== 'manual')
        a.tab = 2;
  }
  return { before, asserts };
}
