/**
 * Atlassian REST client shared by the Jira and Confluence functions.
 *
 * - **Auth.** One `atlassian` DuckDB secret carries the site URL plus one of: an
 *   account email + API token (Cloud basic auth; on Data Center the email field may be
 *   a username and the token its password), a Data Center personal access token (PAT,
 *   `Authorization: Bearer`), or an OAuth 2.0 (3LO) access token. With an OAuth token
 *   and a `cloud_id`, requests go through the Atlassian API gateway
 *   (`https://api.atlassian.com/ex/jira/<cloud_id>`); links shown to users still use
 *   the site URL. Credentials never enter table-function state.
 * - **Deployment.** Jira Cloud speaks REST v3 and the enhanced JQL search; Data Center
 *   speaks v2 and the classic `/search`. `deployment` in the secret forces one,
 *   otherwise `/rest/api/2/serverInfo` is read once per site and cached.
 * - **Rate limits.** Jira Cloud's points-based limiter answers 429 with `Retry-After`
 *   (seconds) and `X-RateLimit-Reset` (ISO 8601); 503 can carry `Retry-After` too.
 *   Both are honoured (bounded), other 5xx and network errors back off
 *   exponentially, and a response flagged `X-RateLimit-NearLimit: true` or with
 *   `X-RateLimit-Remaining: 0` pauses the next call instead of burning a 429.
 */

import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "atlassian";
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 5;
/** Longest single wait for a rate-limit reset. */
export const MAX_RATE_WAIT_MS = 60_000;
const USER_AGENT = `vgi-jira-worker/${VERSION}`;
const DEFAULT_GATEWAY = "https://api.atlassian.com";

export class AtlassianError extends Error {}

export type Deployment = "cloud" | "datacenter";

export interface AtlassianConfig {
  /** Site URL as users browse it (https://acme.atlassian.net, https://jira.corp/jira). */
  siteUrl: string;
  /** Base URL Jira REST paths are appended to (site, or the OAuth gateway). */
  jiraBase: string;
  /** Base URL Confluence `/wiki/...` paths are appended to. */
  confluenceBase: string;
  auth: string;
  /** Forced deployment, or undefined to detect. */
  deployment?: Deployment;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize and check a base URL: https, or http only for a loopback fixture server. */
export function normalizeUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AtlassianError(
      `atlassian secret: ${what} '${raw}' is not a URL (expected e.g. https://acme.atlassian.net)`,
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new AtlassianError(
      `atlassian secret: ${what} must use https:// (http:// is accepted only for 127.0.0.1/localhost)`,
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Build the client config from the `atlassian` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): AtlassianConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new AtlassianError(
      "no atlassian secret: run CREATE SECRET (TYPE atlassian, SITE_URL 'https://<site>.atlassian.net', " +
        "EMAIL '<you@example.com>', API_TOKEN '<token>') — or PERSONAL_ACCESS_TOKEN for Data Center, " +
        "or OAUTH_ACCESS_TOKEN (+ CLOUD_ID) for an OAuth 2.0 app",
    );
  }
  const siteRaw = str(s.site_url);
  if (!siteRaw) throw new AtlassianError("atlassian secret: site_url is required (e.g. https://acme.atlassian.net)");
  const siteUrl = normalizeUrl(siteRaw, "site_url");
  const email = str(s.email);
  const apiToken = str(s.api_token);
  const pat = str(s.personal_access_token);
  const oauth = str(s.oauth_access_token);
  const cloudId = str(s.cloud_id);
  let auth: string;
  if (oauth) auth = `Bearer ${oauth}`;
  else if (pat) auth = `Bearer ${pat}`;
  else if (email && apiToken) auth = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  else {
    throw new AtlassianError(
      "atlassian secret: set EMAIL + API_TOKEN (Cloud), PERSONAL_ACCESS_TOKEN (Data Center) or OAUTH_ACCESS_TOKEN",
    );
  }
  let jiraBase = siteUrl;
  let confluenceBase = siteUrl;
  if (oauth && cloudId) {
    if (!/^[0-9a-fA-F-]{8,64}$/.test(cloudId)) throw new AtlassianError("atlassian secret: cloud_id is not a UUID");
    const gw = normalizeUrl(str(s.api_gateway_url) ?? DEFAULT_GATEWAY, "api_gateway_url");
    jiraBase = `${gw}/ex/jira/${cloudId}`;
    confluenceBase = `${gw}/ex/confluence/${cloudId}`;
  }
  const dep = str(s.deployment)?.toLowerCase();
  let deployment: Deployment | undefined;
  if (dep === "cloud") deployment = "cloud";
  else if (dep === "datacenter" || dep === "data_center" || dep === "server") deployment = "datacenter";
  else if (dep && dep !== "auto") {
    throw new AtlassianError(`atlassian secret: deployment must be 'auto', 'cloud' or 'datacenter' (got '${dep}')`);
  }
  return { siteUrl, jiraBase, confluenceBase, auth, deployment };
}

/** Detected deployment per Jira base URL (module-level: one worker process, many scans). */
const deployments = new Map<string, Deployment>();

/** Cloud or Data Center: the secret's choice, else `/rest/api/2/serverInfo` (cached). */
export async function resolveDeployment(cfg: AtlassianConfig): Promise<Deployment> {
  if (cfg.deployment) return cfg.deployment;
  const hit = deployments.get(cfg.jiraBase);
  if (hit) return hit;
  const body = (await atlassianGet(cfg, `${cfg.jiraBase}/rest/api/2/serverInfo`)) as { deploymentType?: string };
  const dep: Deployment = String(body?.deploymentType ?? "").toLowerCase() === "cloud" ? "cloud" : "datacenter";
  deployments.set(cfg.jiraBase, dep);
  log.debug(`atlassian: ${cfg.siteUrl} is ${dep}`);
  return dep;
}

/** Forget detected deployments (tests). */
export function clearDeploymentCache(): void {
  deployments.clear();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a 429/503 asks us to wait: Retry-After (seconds or HTTP date), else X-RateLimit-Reset. */
export function retryDelayMs(headers: Headers, now = Date.now()): number | undefined {
  const retry = headers.get("Retry-After") ?? headers.get("Beta-Retry-After");
  if (retry) {
    if (/^\d+(\.\d+)?$/.test(retry.trim())) return Math.ceil(Number(retry) * 1000);
    const t = Date.parse(retry);
    if (!Number.isNaN(t)) return Math.max(0, t - now);
  }
  const reset = headers.get("X-RateLimit-Reset");
  if (reset) {
    const t = /^\d+$/.test(reset) ? Number(reset) * 1000 : Date.parse(reset);
    if (!Number.isNaN(t)) return Math.max(0, t - now) + 100;
  }
  return undefined;
}

/** Per-origin "don't call before" instant set by near-limit responses. */
const pauseUntil = new Map<string, number>();

/**
 * GET a JSON resource. `url` is absolute (built from `jiraBase` / `confluenceBase`).
 * `query` values that are undefined or "" are dropped.
 */
export async function atlassianGet(
  cfg: AtlassianConfig,
  url: string,
  query?: Record<string, string | undefined>,
): Promise<unknown> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") u.searchParams.set(k, v);
  const allowed = [new URL(cfg.jiraBase).origin, new URL(cfg.confluenceBase).origin];
  if (!allowed.includes(u.origin)) {
    throw new AtlassianError(`refusing to send credentials to ${u.origin}: it is not the configured Atlassian site`);
  }
  const href = u.toString();
  for (let attempt = 1; ; attempt++) {
    const until = pauseUntil.get(u.origin);
    if (until && until > Date.now()) {
      const wait = Math.min(until - Date.now(), MAX_RATE_WAIT_MS);
      log.info(`atlassian: near the rate limit; pausing ${wait} ms`);
      await sleep(wait);
    }
    let res: Response;
    try {
      res = await fetch(href, {
        headers: { Accept: "application/json", Authorization: cfg.auth, "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new AtlassianError(`GET ${shown(u)} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    const near =
      res.headers.get("X-RateLimit-NearLimit") === "true" || res.headers.get("X-RateLimit-Remaining") === "0";
    if (near && res.ok) {
      const d = retryDelayMs(res.headers);
      pauseUntil.set(u.origin, Date.now() + Math.min(d ?? 1000, MAX_RATE_WAIT_MS));
    }
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new AtlassianError(`GET ${shown(u)} failed with HTTP ${res.status}: ${await errorSummary(res)}`);
    }
    await res.body?.cancel();
    const hinted = res.status === 429 || res.status === 503 ? retryDelayMs(res.headers) : undefined;
    const backoff = 500 * 2 ** (attempt - 1) * (0.75 + Math.random() / 2);
    const delay = Math.min(hinted ?? backoff, MAX_RATE_WAIT_MS);
    log.info(`atlassian: HTTP ${res.status} for ${shown(u)}; retry ${attempt} in ${Math.round(delay)} ms`);
    await sleep(delay);
  }
}

/** Jira errors are `{errorMessages, errors}`; Confluence v2 `{errors:[{title,detail}]}`; v1 `{message}`. */
async function errorSummary(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as {
      errorMessages?: string[];
      errors?: Record<string, string> | { title?: string; detail?: string }[];
      message?: string;
    };
    const parts: string[] = [...(j.errorMessages ?? [])];
    if (Array.isArray(j.errors)) for (const e of j.errors) parts.push([e.title, e.detail].filter(Boolean).join(": "));
    else if (j.errors) for (const [k, v] of Object.entries(j.errors)) parts.push(`${k}: ${v}`);
    if (j.message) parts.push(j.message);
    return parts.filter(Boolean).join(" - ") || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** Path + query of a URL for error messages (credentials are never in a URL). */
function shown(u: URL): string {
  const s = `${u.pathname}${u.search}`;
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}
