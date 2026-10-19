// Safe, bounded reader for a target project's docs and source (read-only).
// Skips secrets, binaries, dependency/build/test-artifact folders and anything outside the
// project root; redacts secret-looking values in what it does return.

import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../config/paths.ts';

export type FileKind = 'doc' | 'source';
export type SkipReason =
  | 'excluded-dir'
  | 'secret-file'
  | 'binary'
  | 'too-large'
  | 'outside-root'
  | 'missing'
  | 'limit-files'
  | 'limit-bytes';

export interface ReadFile {
  /** Project-relative, forward slashes. */
  path: string;
  kind: FileKind;
  size: number;
  content: string;
  redactions: number;
}

export interface ReadResult {
  files: ReadFile[];
  skipped: { path: string; reason: SkipReason }[];
  totalBytes: number;
}

export interface ReadLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: ReadLimits = {
  maxFileBytes: 256 * 1024,
  maxFiles: 500,
  maxTotalBytes: 5 * 1024 * 1024,
};

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'test-results',
  'playwright-report',
  'blob-report',
  'qa-artifacts',
  '.playwright-mcp',
  '.auth',
  '.qa-agent',
]);

const SECRET_FILE = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg|asc)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|netrc|pypirc|htpasswd)$/i,
  /credentials?([._-].*)?\.(json|ya?ml|txt|ini)$/i,
  /secrets?([._-].*)?\.(json|ya?ml|txt|ini|env)$/i,
  /storage-?state.*\.json$/i,
  /\.storageState\.json$/i,
];

const BINARY_EXT =
  /\.(png|jpe?g|gif|bmp|ico|webp|avif|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|exe|dll|so|dylib|bin|class|o|a|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|flac|db|sqlite3?|psd|ai|sketch|fig|xlsx?|docx?|pptx?|lock)$/i;

/** Secret-looking values; each match keeps its prefix and replaces the value. */
const SECRET_VALUE: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /((?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(["'])[^"'\n]{4,}\2/gi,
];

/** Replace secret-looking values with `[REDACTED]`; returns the count. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of SECRET_VALUE) {
    out = out.replace(re, (...m: string[]) => {
      count++;
      return m.length > 4 && m[1] !== undefined && m[2] !== undefined
        ? `${m[1]}${m[2]}[REDACTED]${m[2]}`
        : '[REDACTED]';
    });
  }
  return { text: out, count };
}

export function isSecretFileName(name: string): boolean {
  return SECRET_FILE.some((re) => re.test(name));
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

const toPosix = (p: string) => p.split(path.sep).join('/');

/**
 * Read docs and source files under the given project-relative paths.
 * Paths that escape the project (`..`, symlinks) are skipped, never followed.
 */
export function readProjectSources(
  projectRoot: string,
  targets: { docsPaths: string[]; sourcePaths: string[] },
  limits: ReadLimits = DEFAULT_LIMITS,
): ReadResult {
  const root = fs.realpathSync(projectRoot);
  const result: ReadResult = { files: [], skipped: [], totalBytes: 0 };
  const seen = new Set<string>();
  const skip = (abs: string, reason: SkipReason) =>
    result.skipped.push({ path: toPosix(path.relative(root, abs)) || '.', reason });

  const visit = (abs: string, kind: FileKind) => {
    const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!stat) return skip(abs, 'missing');
    const real = stat.isSymbolicLink() ? fs.realpathSync.native(abs) : abs;
    if (!isInside(root, real)) return skip(abs, 'outside-root');
    const realStat = stat.isSymbolicLink() ? fs.statSync(real) : stat;
    const name = path.basename(abs);
    if (realStat.isDirectory()) {
      if (EXCLUDED_DIRS.has(name) && abs !== root) return skip(abs, 'excluded-dir');
      for (const entry of fs.readdirSync(abs).sort()) visit(path.join(abs, entry), kind);
      return;
    }
    if (!realStat.isFile() || seen.has(real)) return;
    seen.add(real);
    if (isSecretFileName(name)) return skip(abs, 'secret-file');
    if (BINARY_EXT.test(name)) return skip(abs, 'binary');
    if (realStat.size > limits.maxFileBytes) return skip(abs, 'too-large');
    if (result.files.length >= limits.maxFiles) return skip(abs, 'limit-files');
    if (result.totalBytes + realStat.size > limits.maxTotalBytes) return skip(abs, 'limit-bytes');
    const buf = fs.readFileSync(real);
    if (looksBinary(buf)) return skip(abs, 'binary');
    const { text, count } = redactSecrets(buf.toString('utf8'));
    result.totalBytes += realStat.size;
    result.files.push({
      path: toPosix(path.relative(root, abs)),
      kind,
      size: realStat.size,
      content: text,
      redactions: count,
    });
  };

  for (const [kind, list] of [
    ['doc', targets.docsPaths],
    ['source', targets.sourcePaths],
  ] as const) {
    for (const rel of list) {
      const abs = path.resolve(root, rel);
      if (!isInside(root, abs)) skip(abs, 'outside-root');
      else visit(abs, kind);
    }
  }
  return result;
}
