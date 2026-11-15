/**
 * Jira helpers shared by the issue search and the per-issue collections: REST paths
 * per deployment, the JQL search request, the field catalogue cache and user ids.
 */

import { type AtlassianConfig, atlassianGet, type Deployment } from "../atlassian/client.ts";
import { andJoin, type Constraint, eqValues, quote } from "../atlassian/pushdown.ts";
import { type PageRequest, type Row, withQuery } from "../atlassian/table.ts";

/** `/rest/api/3` on Cloud, `/rest/api/2` on Data Center. */
export function api(cfg: AtlassianConfig, dep: Deployment, path: string): string {
  return `${cfg.jiraBase}/rest/api/${dep === "cloud" ? 3 : 2}${path}`;
}

export function agile(cfg: AtlassianConfig, path: string): string {
  return `${cfg.jiraBase}/rest/agile/1.0${path}`;
}

/** Enhanced search rejects a JQL with no restriction; this one matches every issue. */
export const UNBOUNDED_RESTRICTION = 'created >= "1970-01-01"';

/** Make sure a JQL has a search restriction (Cloud's enhanced search requires one). */
export function bounded(jql: string): string {
  const trimmed = jql.trim();
  if (!trimmed || /^order\s+by\b/i.test(trimmed)) return `${UNBOUNDED_RESTRICTION}${trimmed ? ` ${trimmed}` : ""}`;
  return trimmed;
}

/**
 * The JQL search request: `/rest/api/3/search/jql` (nextPageToken) on Cloud, the
 * classic `/rest/api/2/search` (startAt) on Data Center.
 */
export function searchRequest(
  cfg: AtlassianConfig,
  dep: Deployment,
  jql: string,
  fields: string[],
  pageSize: number,
  extra: Record<string, string> = {},
): PageRequest {
  const q = {
    jql: bounded(jql),
    // Enhanced search returns only what fields= names — even the key.
    fields: [...new Set(["key", ...fields])].join(","),
    maxResults: String(pageSize),
    ...extra,
  };
  if (dep === "cloud")
    return { url: withQuery(api(cfg, dep, "/search/jql"), q), paging: { style: "token", key: "issues" } };
  return { url: withQuery(api(cfg, dep, "/search"), q), paging: { style: "offset", key: "issues" } };
}

/** Issue keys pushed on `column` (= / IN), or an explicit argument. */
export function issueKeys(constraints: Constraint[], column: string, arg: unknown): string[] | undefined {
  if (typeof arg === "string" && arg.trim()) {
    return arg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return eqValues(constraints, column);
}

/** JQL for a set of issue keys, ANDed with an optional user JQL. */
export function keysJql(keys: string[] | undefined, userJql: unknown): string {
  const parts = keys?.length ? [`key in (${keys.map(quote).join(", ")})`] : [];
  return andJoin(typeof userJql === "string" ? userJql : "", parts, "ORDER BY key ASC");
}

/** Cloud users carry accountId; Data Center users carry name (and key). */
export function userId(u: unknown): string | null {
  if (!u || typeof u !== "object") return null;
  const r = u as Row;
  return (r.accountId ?? r.name ?? r.key ?? null) as string | null;
}

export function userName(u: unknown): string | null {
  if (!u || typeof u !== "object") return null;
  return ((u as Row).displayName ?? null) as string | null;
}

// ------------------------------------------------------------- field catalogue

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type?: string; items?: string; custom?: string; customId?: number; system?: string };
  clauseNames?: string[];
}

const fieldCache = new Map<string, { at: number; fields: JiraField[] }>();
const FIELD_TTL_MS = 10 * 60_000;

/** The site's field catalogue (`/field`), cached for ten minutes per site. */
export async function jiraFields(cfg: AtlassianConfig, dep: Deployment): Promise<JiraField[]> {
  const hit = fieldCache.get(cfg.jiraBase);
  if (hit && hit.at > Date.now() - FIELD_TTL_MS) return hit.fields;
  const body = await atlassianGet(cfg, api(cfg, dep, "/field"));
  const fields = (Array.isArray(body) ? body : []) as JiraField[];
  fieldCache.set(cfg.jiraBase, { at: Date.now(), fields });
  return fields;
}

export function clearFieldCache(): void {
  fieldCache.clear();
}

export const SPRINT_SCHEMA = "com.pyxis.greenhopper.jira:gh-sprint";

/** The Sprint custom field's id, if Jira Software is installed. */
export function sprintFieldId(fields: JiraField[]): string | undefined {
  return fields.find((f) => f.schema?.custom === SPRINT_SCHEMA)?.id;
}

/** Find a field by id (`customfield_10016`), `cf[10016]`, or (case-insensitive) name. */
export function findField(fields: JiraField[], ref: string): JiraField | undefined {
  const r = ref.trim();
  const cf = /^cf\[(\d+)\]$/i.exec(r);
  const id = cf ? `customfield_${cf[1]}` : r;
  return fields.find((f) => f.id === id) ?? fields.find((f) => f.name.toLowerCase() === r.toLowerCase());
}

/** A sprint value: Cloud objects, or Data Center's `…Sprint@x[id=1,…,name=Sprint 1,…]` strings. */
export function parseSprint(v: unknown): { id: bigint | null; name: string | null; state: string | null } | null {
  if (v == null) return null;
  if (typeof v === "object") {
    const r = v as Row;
    return {
      id: typeof r.id === "number" ? BigInt(r.id) : null,
      name: (r.name ?? null) as string | null,
      state: (r.state ?? null) as string | null,
    };
  }
  const s = String(v);
  const id = /[[,]id=(\d+)/.exec(s)?.[1];
  const name = /[[,]name=([^,\]]*)/.exec(s)?.[1];
  const state = /[[,]state=([^,\]]*)/.exec(s)?.[1];
  return { id: id ? BigInt(id) : null, name: name ?? null, state: state ?? null };
}
