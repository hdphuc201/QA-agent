// URL allowlist enforced by QA Agent before any browser navigation (Playwright MCP's own
// --allowed-origins is a second, non-authoritative layer).

export type UrlDecision = { allowed: true; url: URL } | { allowed: false; reason: string };

/** Paths that commonly change state even on GET; exploration never opens them. */
const UNSAFE_GET = /(^|\/)(log-?out|sign-?out|delete|remove|destroy|reset|unsubscribe)(\/|$|\?)/i;

export function checkUrl(raw: string, allowedOrigins: readonly string[]): UrlDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: 'not an absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { allowed: false, reason: `scheme ${url.protocol} not allowed` };
  if (url.username || url.password)
    return { allowed: false, reason: 'credentials in URL are not allowed' };
  if (!allowedOrigins.includes(url.origin))
    return { allowed: false, reason: `origin ${url.origin} is not in allowedOrigins` };
  return { allowed: true, url };
}

/** Allowed origin AND not a state-changing-looking path. */
export function checkExplorationUrl(raw: string, allowedOrigins: readonly string[]): UrlDecision {
  const d = checkUrl(raw, allowedOrigins);
  if (!d.allowed) return d;
  if (UNSAFE_GET.test(d.url.pathname))
    return { allowed: false, reason: `path ${d.url.pathname} looks state-changing` };
  return d;
}
