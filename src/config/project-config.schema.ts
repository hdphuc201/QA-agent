// Schema of `<target project>/.qa-agent/config.json` (single source: Zod; JSON Schema is derived).
// Credentials never live here: roles reference an `accountKey`, resolved from the environment in P5.

import path from 'node:path';
import { z } from 'zod';
import { ConfigError, readProjectConfig } from './paths.ts';

export const PROJECT_CONFIG_SCHEMA_VERSION = 1;

/** Project-relative POSIX-style path without traversal or absolute prefix. */
const relPath = z
  .string()
  .min(1)
  .refine(
    (p) => !path.isAbsolute(p) && !path.win32.isAbsolute(p) && !/^[\\/]/.test(p),
    'must be relative',
  )
  .refine((p) => !p.split(/[\\/]/).includes('..'), 'must not contain ".."');

const origin = z.string().refine((o) => {
  try {
    const u = new URL(o);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === o;
  } catch {
    return false;
  }
}, 'must be an origin such as https://staging.example.com (no path, no trailing slash)');

// Keys *ending* in a secret word (`password`, `dbPassword`, `apiKey`, `authToken`); `passwordLabel` is fine.
const forbiddenKey = /(pass(word)?|pwd|secret|token|api[-_]?key|cookies?|credentials?)$/i;

export const RoleSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'lowercase role name'),
  accountKey: z.string().regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/, 'e.g. demo.requester'),
  description: z.string().max(300).optional(),
});

export const AuthRecipeSchema = z.strictObject({
  loginPath: z.string().startsWith('/'),
  usernameLabel: z.string().min(1),
  passwordLabel: z.string().min(1),
  submitButton: z.string().min(1),
});

export const ProjectConfigSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(PROJECT_CONFIG_SCHEMA_VERSION),
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'kebab-case id'),
    framework: z.string().max(60).optional(),
    environment: z.enum(['local', 'staging', 'production']).default('local'),
    baseURL: z.url({ protocol: /^https?$/ }),
    allowedOrigins: z.array(origin).min(1),
    docsPaths: z.array(relPath).default([]),
    sourcePaths: z.array(relPath).default([]),
    testOutputRoot: relPath.default('e2e/generated'),
    readOnlyPaths: z.array(relPath).default([]),
    roles: z.array(RoleSchema).default([]),
    workers: z
      .strictObject({
        max: z.int().min(1).max(8).default(1),
        writeHeavy: z.int().min(1).max(8).default(1),
      })
      .default({ max: 1, writeHeavy: 1 }),
    /**
     * Signed-in session reuse per role (Playwright storageState under qa-artifacts/auth/).
     * A cached session is used only after `verifyPath` loads without landing on the login page;
     * otherwise the role signs in again (controlled refresh). Files are purged after the run.
     */
    session: z
      .strictObject({
        cache: z.boolean().default(false),
        maxAgeMinutes: z.int().min(1).max(240).default(15),
        verifyPath: z.string().startsWith('/').default('/'),
        purgeAfterRun: z.boolean().default(true),
      })
      .default({ cache: false, maxAgeMinutes: 15, verifyPath: '/', purgeAfterRun: true }),
    /** Browser engines every generated test runs in (one Playwright project each). */
    browsers: z
      .array(z.enum(['chromium', 'firefox', 'webkit']))
      .min(1)
      .refine((b) => new Set(b).size === b.length, 'browsers must be unique')
      .default(['chromium']),
    /** Destructive steps (delete/remove/… buttons, HTTP DELETE) are BLOCKED unless allowed here. */
    policy: z
      .strictObject({ allowDestructive: z.boolean().default(false) })
      .default({ allowDestructive: false }),
    /** Test data lifecycle: POST <resetPath> before and/or after a run (never on production). */
    testData: z
      .strictObject({
        resetPath: z.string().startsWith('/').optional(),
        resetOn: z.enum(['before', 'after', 'both']).default('before'),
      })
      .optional(),
    exploration: z
      .strictObject({
        maxPages: z.int().min(1).max(200).default(20),
        timeoutMs: z.int().min(1000).max(120_000).default(30_000),
        retries: z.int().min(0).max(3).default(1),
        authRole: z.string().optional(),
        auth: AuthRecipeSchema.optional(),
      })
      .default({ maxPages: 20, timeoutMs: 30_000, retries: 1 }),
  })
  .superRefine((cfg, ctx) => {
    const baseOrigin = new URL(cfg.baseURL).origin;
    if (!cfg.allowedOrigins.includes(baseOrigin)) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedOrigins'],
        message: `must include the baseURL origin ${baseOrigin}`,
      });
    }
    const names = cfg.roles.map((r) => r.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', path: ['roles'], message: 'role names must be unique' });
    }
    if (cfg.workers.writeHeavy > cfg.workers.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['workers', 'writeHeavy'],
        message: 'must be <= workers.max',
      });
    }
    // Generated tests must never land in (or around) application source or protected docs.
    const norm = (p: string) => path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/$/, '');
    const out = norm(cfg.testOutputRoot);
    const within = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b === '.';
    for (const p of [...cfg.sourcePaths, ...cfg.readOnlyPaths]) {
      const other = norm(p);
      if (within(out, other) || within(other, out)) {
        ctx.addIssue({
          code: 'custom',
          path: ['testOutputRoot'],
          message: `must not overlap source/read-only path "${p}"`,
        });
      }
    }
    if (cfg.testData?.resetPath && cfg.environment === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['testData', 'resetPath'],
        message: 'a data reset endpoint is not allowed for a production environment',
      });
    }
    const authRole = cfg.exploration.authRole;
    if (authRole !== undefined && !names.includes(authRole)) {
      ctx.addIssue({
        code: 'custom',
        path: ['exploration', 'authRole'],
        message: `unknown role ${authRole}`,
      });
    }
    if (authRole !== undefined && cfg.exploration.auth === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['exploration', 'auth'],
        message: 'auth recipe required with authRole',
      });
    }
  });

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type Role = z.infer<typeof RoleSchema>;

/** Keys that look like secrets anywhere in the raw JSON (defence in depth beside strict objects). */
export function findSecretLikeKeys(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecretLikeKeys(v, `${at}[${i}]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(forbiddenKey.test(k) ? [`${at}${at ? '.' : ''}${k}`] : []),
    ...findSecretLikeKeys(v, `${at}${at ? '.' : ''}${k}`),
  ]);
}

/** Validate untyped JSON; throws ConfigError listing every issue. */
export function parseProjectConfig(data: unknown, configPath: string): ProjectConfig {
  const secretKeys = findSecretLikeKeys(data);
  if (secretKeys.length > 0) {
    throw new ConfigError(
      `Config must not contain credentials (keys: ${secretKeys.join(', ')})`,
      configPath,
    );
  }
  const result = ProjectConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid QA Agent config:\n  - ${issues.join('\n  - ')}`, configPath);
  }
  return result.data;
}

/** Read and validate `<projectRoot>/.qa-agent/config.json`. Returns null when absent. */
export function loadProjectConfig(
  projectRoot: string,
): { path: string; config: ProjectConfig } | null {
  const raw = readProjectConfig(projectRoot);
  return raw ? { path: raw.path, config: parseProjectConfig(raw.data, raw.path) } : null;
}

/** Directories (project-relative) QA Agent may write to. Everything else is read-only. */
export function writeAllowlist(cfg: ProjectConfig): string[] {
  return ['.qa-agent', cfg.testOutputRoot, 'qa-artifacts'];
}

/** JSON Schema for editors (`$schema`), generated from the Zod source. */
export function projectConfigJsonSchema(): unknown {
  return z.toJSONSchema(ProjectConfigSchema, { io: 'input' });
}
