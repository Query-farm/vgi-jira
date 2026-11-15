/**
 * One factory for every Atlassian list endpoint.
 *
 * A spec names its columns (each with a JSON extractor) and a `plan`: the requests a
 * scan makes, derived from its arguments, pushed filters and the site's deployment.
 * A plan is either a list of phases (one paged request each) or a fan-out (list
 * parents — issues from a JQL search, projects, boards — then read each one's child
 * collection). The factory turns that into a VGI table function that:
 *
 * - streams one upstream page per Arrow batch;
 * - keeps its cursor (phase, next-page URL, pending parent ids) in serializable state,
 *   so a scan resumes on any process over HTTP and survives rate-limit pauses;
 * - reads the `atlassian` secret on every call and never stores it in state;
 * - pushes filters down (narrowing only) and lets the SDK re-apply them exactly.
 */

import {
  batchFromColumns,
  bool,
  constraintRecord,
  dateDay,
  defineTableFunction,
  field,
  float64,
  formatPushedFilters,
  int64,
  list,
  schema,
  type TableDescriptor,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
  type VgiSchema,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { type Category, column, objectTags } from "../meta.ts";
import {
  type AtlassianConfig,
  AtlassianError,
  atlassianGet,
  configFromSecrets,
  type Deployment,
  resolveDeployment,
  SECRET_TYPE,
} from "./client.ts";
import { type Constraint, constraintsOf } from "./pushdown.ts";

// ------------------------------------------------------------------ column helpers

// biome-ignore lint/suspicious/noExplicitAny: Atlassian JSON is untyped.
export type Row = Record<string, any> & { __ctx?: Record<string, string> };

export interface Col {
  name: string;
  type: VgiDataType;
  /** DuckDB spelling for vgi.result_columns_schema. */
  sqlType: string;
  doc: string;
  nullable?: boolean;
  get: (row: Row) => unknown;
}

/** Walk a dotted path through untyped JSON. */
export function at(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export const asStr = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
export const asBool = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null;
export function asBig(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}
export const asNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : null;
/** ISO 8601 (Jira's `2024-01-02T03:04:05.000+0000` too) → TIMESTAMPTZ microseconds. */
export function asTime(v: unknown): bigint | null {
  if (typeof v !== "string" || v === "") return null;
  const fixed = v.replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  const ms = Date.parse(fixed);
  return Number.isNaN(ms) ? null : BigInt(ms) * 1000n;
}
/** `yyyy-MM-dd` → DATE (days since epoch). */
export function asDate(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const ms = Date.parse(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}
export const asStrList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x) => x != null).map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : null;
export const asJson = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];

type Getter = string | ((r: Row) => unknown);
const pick = (r: Row, g: Getter) => (typeof g === "string" ? at(r, g) : g(r));

function mk(
  name: string,
  type: VgiDataType,
  sqlType: string,
  doc: string,
  get: (r: Row) => unknown,
  nullable = true,
): Col {
  return { name, type, sqlType, doc, get, nullable };
}

export const C = {
  str: (name: string, doc: string, g: Getter, nullable = true) =>
    mk(name, utf8(), "VARCHAR", doc, (r) => asStr(pick(r, g)), nullable),
  time: (name: string, doc: string, g: Getter) =>
    mk(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, (r) => asTime(pick(r, g))),
  date: (name: string, doc: string, g: Getter) => mk(name, dateDay(), "DATE", doc, (r) => asDate(pick(r, g))),
  bool: (name: string, doc: string, g: Getter) => mk(name, bool, "BOOLEAN", doc, (r) => asBool(pick(r, g))),
  big: (name: string, doc: string, g: Getter, nullable = true) =>
    mk(name, int64(), "BIGINT", doc, (r) => asBig(pick(r, g)), nullable),
  num: (name: string, doc: string, g: Getter) => mk(name, float64(), "DOUBLE", doc, (r) => asNum(pick(r, g))),
  strList: (name: string, doc: string, g: Getter) =>
    mk(name, list(utf8()), "VARCHAR[]", doc, (r) => asStrList(pick(r, g))),
  bigList: (name: string, doc: string, g: Getter) =>
    mk(name, list(int64()), "BIGINT[]", doc, (r) => {
      const v = pick(r, g);
      return Array.isArray(v) ? v.map(asBig).filter((x): x is bigint => x !== null) : null;
    }),
  json: (name: string, doc: string, g: Getter) => mk(name, utf8(), "JSON", doc, (r) => asJson(pick(r, g))),
  ctx: (name: string, doc: string, key: string, nullable = false) =>
    mk(name, utf8(), "VARCHAR", doc, (r) => r.__ctx?.[key] ?? null, nullable),
};

/** The Arrow output schema for columns (comments ride along as field metadata). */
export function schemaOf(columns: Col[]): VgiSchema {
  return schema(
    columns.map((c) =>
      c.sqlType === "JSON"
        ? field(c.name, c.type, c.nullable ?? true, new Map([["comment", c.doc], JSON_META]))
        : column(c.name, c.type, c.doc, c.nullable ?? true),
    ),
  );
}

// ------------------------------------------------------------------------- paging

/** How a response pages. */
export type Paging =
  /** The body is the whole array (or object). */
  | { style: "array"; key?: string }
  /** Jira `startAt`/`maxResults` + `isLast`/`total` (`values`, `issues`, `comments` …). */
  | { style: "offset"; key: string; param?: string; limitParam?: string }
  /** Plain array paged by `startAt`/`maxResults` (ends on an empty page). */
  | { style: "arrayOffset"; param?: string }
  /** Confluence `results` + `_links.next` (relative to the site, or to `_links.base`). */
  | { style: "links"; key?: string }
  /** Jira enhanced search: `nextPageToken`. */
  | { style: "token"; key: string };

/** One paged request of a scan. */
export interface PageRequest {
  /** Absolute URL with its query string. */
  url: string;
  paging: Paging;
  /** Per-request values exposed to columns through `C.ctx` (e.g. the issue key). */
  ctx?: Record<string, string>;
}

export function withQuery(url: string, q: Record<string, string | undefined>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") u.searchParams.set(k, v);
  return u.toString();
}

/** Extract a page's rows and the absolute URL of the next page (or null). */
export function parsePage(cfg: AtlassianConfig, req: { url: string; paging: Paging }, url: string, body: unknown) {
  const p = req.paging;
  const b = (body ?? {}) as Row;
  switch (p.style) {
    case "array": {
      const v = p.key ? at(b, p.key) : body;
      return { rows: Array.isArray(v) ? (v as Row[]) : v && typeof v === "object" ? [v as Row] : [], next: null };
    }
    case "offset": {
      const rows = (Array.isArray(b[p.key]) ? b[p.key] : []) as Row[];
      const start = Number(b.startAt ?? new URL(url).searchParams.get(p.param ?? "startAt") ?? 0);
      const total = typeof b.total === "number" ? b.total : undefined;
      const max = typeof b.maxResults === "number" ? b.maxResults : rows.length;
      let more: boolean;
      if (typeof b.isLast === "boolean") more = !b.isLast;
      else if (total !== undefined) more = start + rows.length < total;
      else more = rows.length > 0 && rows.length >= max;
      if (rows.length === 0) more = false;
      return {
        rows,
        next: more ? withQuery(url, { [p.param ?? "startAt"]: String(start + rows.length) }) : null,
      };
    }
    case "arrayOffset": {
      const rows = (Array.isArray(body) ? body : []) as Row[];
      const start = Number(new URL(url).searchParams.get(p.param ?? "startAt") ?? 0);
      return {
        rows,
        // Atlassian may return fewer than maxResults before the end: stop only on an empty page.
        next: rows.length > 0 ? withQuery(url, { [p.param ?? "startAt"]: String(start + rows.length) }) : null,
      };
    }
    case "links": {
      const rows = (Array.isArray(b[p.key ?? "results"]) ? b[p.key ?? "results"] : []) as Row[];
      const next = at(b, "_links.next");
      if (typeof next !== "string" || !next || rows.length === 0) return { rows, next: null };
      if (/^https?:\/\//.test(next)) return { rows, next };
      // v2 links start with /wiki/…; v1 links are relative to _links.base (…/wiki).
      const base = next.startsWith("/wiki/") ? cfg.confluenceBase : `${cfg.confluenceBase}/wiki`;
      return { rows, next: base + next };
    }
    case "token": {
      const rows = (Array.isArray(b[p.key]) ? b[p.key] : []) as Row[];
      const tok = b.nextPageToken;
      const more = typeof tok === "string" && tok !== "" && b.isLast !== true;
      return { rows, next: more ? withQuery(url, { nextPageToken: tok }) : null };
    }
  }
}

// --------------------------------------------------------------------- the factory

export interface ScanContext<A> {
  args: A;
  constraints: Constraint[];
  cfg: AtlassianConfig;
  deployment: Deployment;
  /** Output columns this scan must fill (projection ∪ filter columns). */
  needed: Set<string>;
}

export type Plan =
  | { kind: "phases"; phases: PageRequest[] }
  | {
      kind: "fanout";
      /** Parent ids given explicitly (argument / pushed = / IN); otherwise list `parents`. */
      ids?: string[];
      parents: PageRequest[];
      parentId: (row: Row) => string | null;
      /** Queue entries per parent id (default: the id itself). */
      expand?: (id: string) => string[];
      child: (id: string) => PageRequest;
    };

export interface FnExample {
  sql: string;
  description: string;
}

export interface TableSpec<A> {
  name: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  args?: Record<string, VgiDataType>;
  argDocs?: Record<string, string>;
  argDefaults?: Record<string, unknown>;
  argConstraints?: Record<string, Record<string, unknown>>;
  columns: Col[];
  /** Jira functions detect Cloud vs Data Center first; Confluence is Cloud-only. */
  product: "jira" | "confluence";
  plan: (scan: ScanContext<A>) => Plan | Promise<Plan>;
  /** Reshape a page's rows (flatten nested histories, explode links …). */
  rows?: (rows: Row[], scan: ScanContext<A>, ctx: Record<string, string>) => Row[];
  /** HTTP statuses that mean "nothing here" → zero rows (404 issue, 400 kanban sprints). */
  emptyOn?: number[];
  pushdown?: string;
  examples: FnExample[];
  /** Columns attested NOT NULL + PRIMARY KEY when exposed as a catalog table. */
  primaryKey?: string;
}

interface ScanState {
  phase: number;
  /** Absolute next-page URL; "" = start the current phase / child from its first request. */
  next: string;
  /** Fan-out: pending parent ids, newline-joined (the head is being read). */
  queue: string;
  parentPhase: number;
  parentNext: string;
  /** Fan-out: explicit ids have been queued. */
  started: boolean;
}

function tagsOf<A>(spec: TableSpec<A>): Record<string, string> {
  return {
    domain: spec.product === "jira" ? "project management" : "knowledge management",
    ...objectTags({
      title: spec.title,
      category: spec.category,
      keywords: spec.keywords,
      docLlm: spec.docLlm,
      docMd: spec.docMd + (spec.pushdown ? `\n\n**Pushdown:** ${spec.pushdown}` : ""),
    }),
    "vgi.result_columns_schema": JSON.stringify(
      spec.columns.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    ),
  };
}

/** Columns this scan must fill: the projection plus every column a pushed filter reads. */
export function neededColumns(outputSchema: VgiSchema, constraints: Constraint[]): Set<string> {
  const s = new Set(outputSchema.fields.map((f) => f.name));
  for (const c of constraints) s.add(c.column);
  return s;
}

/** Columns referenced anywhere in the pushed filters (including under OR/NOT). */
function filterColumns(filters: unknown): string[] {
  const out: string[] = [];
  const walk = (e: unknown) => {
    if (!e || typeof e !== "object") return;
    const n = e as Record<string, unknown>;
    if (n.node === "column_ref" && typeof n.columnName === "string") out.push(n.columnName);
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(filters);
  return out;
}

/**
 * Emit rows as one batch over the FULL bound schema (filter columns included, so the
 * SDK's exact re-filter sees them); the SDK projects the batch down afterwards.
 */
export function emitRows(
  out: { emit: (b: never) => void },
  fullSchema: VgiSchema,
  columns: Col[],
  rows: Row[],
  needed: Set<string>,
): void {
  const cols: Record<string, unknown[]> = {};
  for (const f of fullSchema.fields) {
    const c = columns.find((x) => x.name === f.name);
    cols[f.name] = c && needed.has(f.name) ? rows.map((r) => c.get(r)) : rows.map(() => null);
  }
  out.emit(batchFromColumns(cols, fullSchema) as never);
}

/** A spec with no arguments exposed as a catalog table (`SELECT … FROM jira.main.projects`). */
export function defineCatalogTable(spec: TableSpec<Record<string, never>>, schemaName: string): TableDescriptor {
  const fn = defineAtlassianTable({ ...spec, name: `${spec.name}_scan` });
  const pk = spec.primaryKey;
  const record = (id: string, kind: "NOT_NULL" | "PRIMARY_KEY") =>
    constraintRecord({
      schemaPath: [schemaName],
      table: spec.name,
      id,
      kind,
      columns: [[pk as string]],
      enforcement: "ENFORCED",
      validation: "ALL_ROWS",
    });
  return {
    name: spec.name,
    comment: spec.description,
    columns: schemaOf(spec.columns),
    function: fn,
    constraints: pk ? [record(`${pk}_not_null`, "NOT_NULL"), record("pk", "PRIMARY_KEY")] : [],
    tags: { ...tagsOf(spec), "vgi.example_queries": JSON.stringify(spec.examples) },
  };
}

export function defineAtlassianTable<A extends Record<string, unknown>>(spec: TableSpec<A>): VgiFunction {
  const outSchema = schemaOf(spec.columns);

  return defineTableFunction<A, ScanState>({
    name: spec.name,
    description: spec.description,
    args: spec.args ?? {},
    argDocs: spec.argDocs,
    argDefaults: spec.argDefaults,
    argConstraints: spec.argConstraints as never,
    filterPushdown: true,
    projectionPushdown: true,
    // DuckDB drops pushed predicates from its plan; the SDK re-applies them exactly,
    // so translating a predicate only ever narrows what Atlassian returns.
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => ({ phase: 0, next: "", queue: "", parentPhase: 0, parentNext: "", started: false }),
    process: async (params, state, out) => {
      const cfg = configFromSecrets(params.secrets);
      const constraints = constraintsOf(params.pushdownFilters);
      const needed = neededColumns(params.outputSchema, constraints);
      for (const c of filterColumns(params.pushdownFilters?.filters)) needed.add(c);
      const deployment = spec.product === "jira" ? await resolveDeployment(cfg) : "cloud";
      const scan: ScanContext<A> = { args: params.args, constraints, cfg, deployment, needed };
      log.debug(`${spec.name}: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);
      const full = params.initCall.output_schema;
      const plan = await spec.plan(scan);

      const fetchPage = async (req: PageRequest, url: string) => {
        try {
          return parsePage(cfg, req, url, await atlassianGet(cfg, url));
        } catch (err) {
          const m = err instanceof AtlassianError ? /HTTP (\d+)/.exec(err.message) : null;
          if (m && spec.emptyOn?.includes(Number(m[1]))) return { rows: [] as Row[], next: null };
          throw err;
        }
      };
      /** Emit a page's rows; false when there were none (keep reading). */
      const emit = (rows: Row[], ctx: Record<string, string>): boolean => {
        let rs = rows.map((r) => ({ ...r, __ctx: ctx }));
        if (spec.rows) rs = spec.rows(rs, scan, ctx).map((r) => ({ ...r, __ctx: r.__ctx ?? ctx }));
        if (rs.length === 0) return false;
        emitRows(out as never, full, spec.columns, rs, needed);
        return true;
      };

      // Loop until a page yields rows or the scan ends, so no empty batches go out.
      for (;;) {
        if (plan.kind === "fanout") {
          if (plan.ids && !state.started) {
            state.queue = [...new Set(plan.ids)].join("\n");
            state.started = true;
            state.parentPhase = plan.parents.length;
          }
          if (!state.queue) {
            const pp = plan.parents[state.parentPhase];
            if (!pp || plan.ids) {
              out.finish();
              return;
            }
            const page = await fetchPage(pp, state.parentNext || pp.url);
            if (page.next) state.parentNext = page.next;
            else {
              state.parentPhase += 1;
              state.parentNext = "";
            }
            state.queue = page.rows
              .map(plan.parentId)
              .filter((x): x is string => !!x)
              .flatMap((id) => plan.expand?.(id) ?? [id])
              .join("\n");
            continue;
          }
          const ids = state.queue.split("\n");
          const req = plan.child(ids[0] as string);
          const page = await fetchPage(req, state.next || req.url);
          if (page.next) state.next = page.next;
          else {
            state.queue = ids.slice(1).join("\n");
            state.next = "";
          }
          if (emit(page.rows, req.ctx ?? {})) return;
          continue;
        }
        const phase = plan.phases[state.phase];
        if (!phase) {
          out.finish();
          return;
        }
        const page = await fetchPage(phase, state.next || phase.url);
        if (page.next) state.next = page.next;
        else {
          state.phase += 1;
          state.next = "";
        }
        if (emit(page.rows, phase.ctx ?? {})) return;
      }
    },
    tags: tagsOf(spec),
    examples: spec.examples,
  });
}
