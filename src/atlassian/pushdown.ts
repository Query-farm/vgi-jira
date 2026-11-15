/**
 * Turn DuckDB's pushed-down WHERE predicates into JQL / CQL.
 *
 * Every table function sets `autoApplyFilters: true`, so the SDK re-applies every
 * pushed predicate to each batch exactly. Translation therefore only has to NARROW the
 * upstream query without ever dropping a matching row: predicates we cannot express
 * are not sent, and anything the server matches more loosely (case-insensitive names,
 * minute-precision dates in the user's time zone) is tightened again by the SDK.
 *
 * Only top-level conjuncts are translated (a predicate under OR/NOT is left to the
 * SDK), so the generated clause list is always implied by the SQL filter.
 */

import type { PushdownFilters } from "@query-farm/vgi";

type Expr = PushdownFilters["filters"][number];

/** One translatable constraint on a column. */
export type Constraint =
  | { kind: "cmp"; column: string; op: "eq" | "ne" | "gt" | "ge" | "lt" | "le"; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "null"; column: string; negated: boolean }
  | { kind: "contains"; column: string; value: unknown };

const FLIP: Record<string, "eq" | "ne" | "gt" | "ge" | "lt" | "le"> = {
  eq: "eq",
  ne: "ne",
  gt: "lt",
  ge: "le",
  lt: "gt",
  le: "ge",
};

function unwrap(e: Expr): Expr {
  return e.node === "cast" ? unwrap(e.expression) : e;
}

function one(e: Expr, out: Constraint[]): void {
  if (e.node === "column_ref") {
    out.push({ kind: "cmp", column: e.columnName, op: "eq", value: true });
    return;
  }
  if (e.node === "and") {
    for (const c of e.children) one(c, out);
    return;
  }
  if (e.node === "is_null") {
    const c = unwrap(e.expression);
    if (c.node === "column_ref") out.push({ kind: "null", column: c.columnName, negated: !!e.negated });
    return;
  }
  if (e.node === "not") {
    const inner = unwrap(e.expression);
    if (inner.node === "is_null") {
      const c = unwrap(inner.expression);
      if (c.node === "column_ref") out.push({ kind: "null", column: c.columnName, negated: !inner.negated });
    } else if (inner.node === "column_ref") {
      out.push({ kind: "cmp", column: inner.columnName, op: "eq", value: false });
    }
    return;
  }
  if (e.node === "comparison" && e.op in FLIP) {
    const [l, r] = [unwrap(e.left), unwrap(e.right)];
    if (l.node === "column_ref" && r.node === "literal" && r.value != null) {
      out.push({ kind: "cmp", column: l.columnName, op: e.op as "eq", value: r.value });
    } else if (r.node === "column_ref" && l.node === "literal" && l.value != null) {
      out.push({ kind: "cmp", column: r.columnName, op: FLIP[e.op] ?? "eq", value: l.value });
    }
    return;
  }
  if (e.node === "in" && !e.negated && e.set.kind === "literal") {
    const col = unwrap(e.expression);
    const values = e.set.values.filter((v) => v != null);
    if (col.node === "column_ref" && values.length > 0 && values.length === e.set.values.length) {
      out.push({ kind: "in", column: col.columnName, values });
    }
    return;
  }
  if (e.node === "call" && e.arguments.length === 2) {
    const fn = typeof e.function === "string" ? e.function : e.function.name;
    if (fn === "list_contains" || fn === "list_has" || fn === "array_contains" || fn === "array_has") {
      const [c, v] = [unwrap(e.arguments[0] as Expr), unwrap(e.arguments[1] as Expr)];
      if (c.node === "column_ref" && v.node === "literal" && v.value != null) {
        out.push({ kind: "contains", column: c.columnName, value: v.value });
      }
    }
  }
}

/** The top-level, translatable constraints of a scan's pushed filters. */
export function constraintsOf(filters: PushdownFilters | undefined): Constraint[] {
  const out: Constraint[] = [];
  for (const f of filters?.filters ?? []) one(f, out);
  return out;
}

/** A pushed literal for a TIMESTAMPTZ/DATE column as epoch milliseconds. */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === "bigint") return Number(v / 1000n);
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** Equality / IN values pushed for a column (as strings), or undefined if unconstrained. */
export function eqValues(constraints: Constraint[], column: string): string[] | undefined {
  let set: string[] | undefined;
  for (const c of constraints) {
    if (c.column !== column) continue;
    let vs: string[] | undefined;
    if (c.kind === "cmp" && c.op === "eq" && (typeof c.value === "string" || typeof c.value === "bigint"))
      vs = [String(c.value)];
    else if (c.kind === "cmp" && c.op === "eq" && typeof c.value === "number") vs = [String(c.value)];
    else if (c.kind === "in") vs = c.values.map(String);
    if (!vs) continue;
    set = set ? set.filter((v) => vs.includes(v)) : [...new Set(vs)];
  }
  return set;
}

// ------------------------------------------------------------------ JQL / CQL text

/**
 * Quote a JQL/CQL string literal. Both languages accept double-quoted strings with
 * backslash escapes for `"` and `\`; quoting every value also neutralises reserved
 * words (AND, OR, EMPTY…) and reserved characters.
 */
export function quote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

/** Quote a field name when it is not a bare identifier (custom field names, "Epic Link"). */
export function fieldName(f: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(f) ? f : quote(f);
}

/** JQL/CQL date literal "yyyy-MM-dd HH:mm" (UTC) for epoch ms. */
export function dateLiteral(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `"${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}"`;
}

/** JQL dates are minute-precision in the *user's* time zone: widen by a day (max tz offset + 1 minute). */
const TZ_SLACK_MS = 26 * 3600 * 1000;

/** How one SQL column maps onto a JQL/CQL field. */
export interface FieldMap {
  /** JQL/CQL field (already a valid clause name). */
  field: string;
  kind: "string" | "number" | "time" | "list" | "state";
  /** `IS NULL` → `field is EMPTY` (only for fields where EMPTY is meaningful). */
  empty?: boolean;
  /** Range operators allowed (time columns). */
  range?: boolean;
  /** `ne` allowed. */
  ne?: boolean;
  /** Value rewriting (e.g. state open/closed → statusCategory). Return a raw clause. */
  clause?: (op: string, v: unknown) => string | undefined;
}

function lit(m: FieldMap, v: unknown): string | undefined {
  if (m.kind === "number") {
    if (typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v))) return String(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return v;
    return undefined;
  }
  if (typeof v === "string") return quote(v);
  if (typeof v === "bigint" || typeof v === "number") return String(v);
  return undefined;
}

const OPS: Record<string, string> = { eq: "=", ne: "!=", gt: ">", ge: ">=", lt: "<", le: "<=" };

/**
 * Translate constraints into JQL/CQL clauses (to be AND-joined). A column with no
 * mapping, or a predicate the mapping cannot express, contributes nothing.
 */
export function buildClauses(constraints: Constraint[], fields: Record<string, FieldMap>): string[] {
  const parts: string[] = [];
  for (const c of constraints) {
    const m = fields[c.column];
    if (!m) continue;
    if (m.clause) {
      if (c.kind === "cmp") {
        const s = m.clause(c.op, c.value);
        if (s) parts.push(s);
      } else if (c.kind === "in") {
        const ss = c.values.map((v) => m.clause?.("eq", v));
        if (ss.every(Boolean) && ss.length) parts.push(ss.length === 1 ? (ss[0] as string) : `(${ss.join(" OR ")})`);
      }
      continue;
    }
    if (m.kind === "time") {
      if (c.kind !== "cmp") continue;
      const ms = toEpochMs(c.value);
      if (ms === undefined) continue;
      // Widen so the server's minute/time-zone rounding can never drop a matching row.
      if (c.op === "gt" || c.op === "ge") parts.push(`${m.field} >= ${dateLiteral(ms - TZ_SLACK_MS)}`);
      else if (c.op === "lt" || c.op === "le") parts.push(`${m.field} <= ${dateLiteral(ms + TZ_SLACK_MS)}`);
      else if (c.op === "eq") {
        parts.push(`${m.field} >= ${dateLiteral(ms - TZ_SLACK_MS)}`, `${m.field} <= ${dateLiteral(ms + TZ_SLACK_MS)}`);
      }
      continue;
    }
    if (c.kind === "null") {
      if (m.empty) parts.push(`${m.field} ${c.negated ? "is not EMPTY" : "is EMPTY"}`);
      continue;
    }
    if (m.kind === "list") {
      if (c.kind !== "contains") continue;
      const v = lit(m, c.value);
      if (v !== undefined) parts.push(`${m.field} = ${v}`);
      continue;
    }
    if (c.kind === "cmp") {
      if (c.op === "eq" || (c.op === "ne" && m.ne) || (m.range && c.op !== "ne")) {
        const v = lit(m, c.value);
        if (v !== undefined) parts.push(`${m.field} ${OPS[c.op]} ${v}`);
      }
    } else if (c.kind === "in") {
      const vs = c.values.map((v) => lit(m, v));
      if (vs.some((v) => v === undefined) || vs.length > 200) continue;
      const uniq = [...new Set(vs as string[])];
      parts.push(uniq.length === 1 ? `${m.field} = ${uniq[0]}` : `${m.field} in (${uniq.join(", ")})`);
    }
  }
  return parts;
}

/**
 * Split user JQL/CQL into its condition and its trailing `ORDER BY …` (outside quotes),
 * so generated clauses can be ANDed in front of the ordering.
 */
export function splitOrderBy(q: string): { where: string; orderBy: string } {
  let quoteCh: string | null = null;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i] as string;
    if (quoteCh) {
      if (ch === "\\") i++;
      else if (ch === quoteCh) quoteCh = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteCh = ch;
      continue;
    }
    if ((i === 0 || /\s|\)/.test(q[i - 1] as string)) && /^order\s+by\b/i.test(q.slice(i))) {
      return { where: q.slice(0, i).trim(), orderBy: q.slice(i).trim() };
    }
  }
  return { where: q.trim(), orderBy: "" };
}

/** AND together a user query and generated clauses, keeping the user's ORDER BY last. */
export function andJoin(userQuery: string | null | undefined, parts: string[], defaultOrder = ""): string {
  const { where, orderBy } = splitOrderBy(userQuery ?? "");
  const all = [...(where ? [parts.length ? `(${where})` : where] : []), ...parts];
  const cond = all.join(" AND ");
  const order = orderBy || defaultOrder;
  return [cond, order].filter(Boolean).join(" ");
}
