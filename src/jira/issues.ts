/**
 * `jira.main.issues(jql := NULL, page_size := 100)` — Jira issues from a JQL search.
 *
 * - **Pushdown.** Top-level WHERE conjuncts on mapped columns become JQL clauses
 *   (quoted/escaped) ANDed with the `jql` argument; the user's ORDER BY is kept last.
 * - **Projection.** Only the Jira fields behind the selected (and filtered) columns go
 *   in the `fields=` parameter.
 * - **Custom fields.** `custom_fields` is a JSON map keyed by field name (fetched only
 *   when selected). The ATTACH option `custom_fields 'story_points=Story point
 *   estimate:DOUBLE, team=customfield_10030'` hoists named fields into typed columns.
 * - **Paging.** Cloud's `nextPageToken` / Data Center's `startAt` is the cursor and lives
 *   in the scan state, so a scan resumes on any process.
 *
 * Column names align with the GitHub and GitLab workers' issues tables (repo, number,
 * title, state, user_login, assignees, labels, body, html_url, created_at, updated_at,
 * closed_at) so issues UNION across trackers.
 */

import {
  attachOption,
  bool,
  dateDay,
  defineTableFunction,
  float64,
  formatPushedFilters,
  int64,
  list,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
} from "@query-farm/vgi";
import {
  AtlassianError,
  atlassianGet,
  configFromSecrets,
  type Deployment,
  resolveDeployment,
  SECRET_TYPE,
} from "../atlassian/client.ts";
import { andJoin, buildClauses, constraintsOf, type FieldMap } from "../atlassian/pushdown.ts";
import {
  asBig,
  asBool,
  asDate,
  asJson,
  asNum,
  asStr,
  asTime,
  C,
  type Col,
  emitRows,
  neededColumns,
  parsePage,
  type Row,
  schemaOf,
} from "../atlassian/table.ts";
import { adfToText } from "../atlassian/text.ts";
import { log } from "../log.ts";
import { objectTags } from "../meta.ts";
import {
  findField,
  type JiraField,
  jiraFields,
  parseSprint,
  searchRequest,
  sprintFieldId,
  userId,
  userName,
} from "./common.ts";

const F = (r: Row): Row => (r.fields ?? {}) as Row;
const names = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? (x as Row).name : x)).filter((x) => x != null) : null;

/** Placeholder field ids resolved from the field catalogue. */
const SPRINT = "@sprint";
const CUSTOM = "@custom";

interface IssueCol extends Col {
  /** Jira fields this column needs in `fields=`. */
  fields: string[];
  /** Hoisted custom field: the field reference from the ATTACH option. */
  ref?: string;
}

function ic(col: Col, ...fields: string[]): IssueCol {
  return { ...col, fields };
}

/** The standard issue columns. `__sprints` / `__custom` are attached to each row in process(). */
export const ISSUE_COLUMNS: IssueCol[] = [
  ic(
    C.str(
      "repo",
      "Project key — the tracker-neutral 'repo' column of the GitHub/GitLab workers. Pushed down (project).",
      (r) => F(r).project?.key,
    ),
    "project",
  ),
  ic(
    C.str("project_key", "Project key (e.g. ENG). Pushed down (project = / IN / !=).", (r) => F(r).project?.key),
    "project",
  ),
  ic(
    C.str("project_name", "Project name.", (r) => F(r).project?.name),
    "project",
  ),
  ic(
    C.big(
      "number",
      "Issue number within the project (the digits of the key), aligned with GitHub/GitLab 'number'.",
      (r) => (typeof r.key === "string" ? r.key.replace(/^.*-/, "") : null),
    ),
  ),
  ic(C.str("key", "Issue key (ENG-42). Pushed down (key = / IN).", "key", false)),
  ic(C.big("id", "Jira's numeric issue id. Pushed down (id =).", "id", false)),
  ic(
    C.str("title", "Issue summary (aligned with GitHub/GitLab 'title').", (r) => F(r).summary),
    "summary",
  ),
  ic(
    C.str("summary", "Issue summary (Jira's name for title).", (r) => F(r).summary),
    "summary",
  ),
  ic(
    C.str(
      "state",
      "'closed' when the status category is Done, else 'open' (GitHub vocabulary). Pushed down (statusCategory).",
      (r) => {
        const k = F(r).status?.statusCategory?.key;
        return k == null ? null : k === "done" ? "closed" : "open";
      },
    ),
    "status",
  ),
  ic(
    C.str("status", "Workflow status name (e.g. In Progress). Pushed down.", (r) => F(r).status?.name),
    "status",
  ),
  ic(
    C.str(
      "status_category",
      "Status category: To Do, In Progress or Done. Pushed down.",
      (r) => F(r).status?.statusCategory?.name,
    ),
    "status",
  ),
  ic(
    C.str(
      "issue_type",
      "Issue type name (Bug, Story, Task, Epic, Sub-task …). Pushed down.",
      (r) => F(r).issuetype?.name,
    ),
    "issuetype",
  ),
  ic(
    C.bool(
      "is_subtask",
      "Whether the issue type is a sub-task type. Pushed down (subTaskIssueTypes()).",
      (r) => F(r).issuetype?.subtask,
    ),
    "issuetype",
  ),
  ic(
    C.str("priority", "Priority name. Pushed down (= / IN / IS NULL).", (r) => F(r).priority?.name),
    "priority",
  ),
  ic(
    C.str(
      "resolution",
      "Resolution name; NULL while unresolved. Pushed down (= / IN / IS NULL).",
      (r) => F(r).resolution?.name,
    ),
    "resolution",
  ),
  ic(
    C.str(
      "user_login",
      "Reporter's accountId (Cloud) or username (Data Center), aligned with GitHub/GitLab 'user_login'. Pushed down (reporter).",
      (r) => userId(F(r).reporter),
    ),
    "reporter",
  ),
  ic(
    C.str("reporter_display_name", "Reporter's display name.", (r) => userName(F(r).reporter)),
    "reporter",
  ),
  ic(
    C.str("creator", "Creator's accountId (Cloud) or username (Data Center).", (r) => userId(F(r).creator)),
    "creator",
  ),
  ic(
    C.str(
      "assignee",
      "Assignee's accountId (Cloud) or username (Data Center); NULL when unassigned. Pushed down (= / IN / IS NULL).",
      (r) => userId(F(r).assignee),
    ),
    "assignee",
  ),
  ic(
    C.str("assignee_display_name", "Assignee's display name.", (r) => userName(F(r).assignee)),
    "assignee",
  ),
  ic(
    C.strList(
      "assignees",
      "Assignee ids as a list (zero or one element), aligned with GitHub/GitLab 'assignees'. list_contains pushes down.",
      (r) => {
        const id = userId(F(r).assignee);
        return id ? [id] : [];
      },
    ),
    "assignee",
  ),
  ic(
    C.strList("labels", "Labels. list_contains(labels, 'x') pushes down (labels = \"x\").", (r) => F(r).labels),
    "labels",
  ),
  ic(
    C.strList("components", "Component names. list_contains pushes down.", (r) => names(F(r).components)),
    "components",
  ),
  ic(
    C.strList("fix_versions", "Fix version names. list_contains pushes down.", (r) => names(F(r).fixVersions)),
    "fixVersions",
  ),
  ic(
    C.strList("affects_versions", "Affects version names. list_contains pushes down.", (r) => names(F(r).versions)),
    "versions",
  ),
  ic(
    C.str(
      "parent_key",
      "Parent issue key (epic or parent of a sub-task). Pushed down on Cloud (parent =).",
      (r) => F(r).parent?.key,
    ),
    "parent",
  ),
  ic(
    C.str("parent_summary", "Parent issue summary.", (r) => F(r).parent?.fields?.summary),
    "parent",
  ),
  ic(
    C.bigList(
      "sprint_ids",
      "Ids of the sprints the issue is or was in (Jira Software). list_contains(sprint_ids, 5) pushes down (sprint = 5).",
      (r) => (r.__sprints as ReturnType<typeof parseSprint>[] | undefined)?.map((s) => s?.id ?? null),
    ),
    SPRINT,
  ),
  ic(
    C.strList("sprint_names", "Names of the sprints the issue is or was in.", (r) =>
      (r.__sprints as ReturnType<typeof parseSprint>[] | undefined)?.map((s) => s?.name).filter(Boolean),
    ),
    SPRINT,
  ),
  ic(
    C.date("due_date", "Due date.", (r) => F(r).duedate),
    "duedate",
  ),
  ic(
    C.big("original_estimate_seconds", "Original time estimate in seconds.", (r) => F(r).timeoriginalestimate),
    "timeoriginalestimate",
  ),
  ic(
    C.big("remaining_estimate_seconds", "Remaining time estimate in seconds.", (r) => F(r).timeestimate),
    "timeestimate",
  ),
  ic(
    C.big("time_spent_seconds", "Time logged in seconds.", (r) => F(r).timespent),
    "timespent",
  ),
  ic(
    C.big("votes", "Vote count.", (r) => F(r).votes?.votes),
    "votes",
  ),
  ic(
    C.big("watches", "Watcher count.", (r) => F(r).watches?.watchCount),
    "watches",
  ),
  ic(
    C.str(
      "body",
      "Description as plain text (from ADF on Cloud, wiki markup on Data Center), aligned with GitHub/GitLab 'body'.",
      (r) => adfToText(F(r).description),
    ),
    "description",
  ),
  ic(
    C.json("description_adf", "Description as raw Atlassian Document Format JSON (Cloud); NULL on Data Center.", (r) =>
      typeof F(r).description === "object" ? F(r).description : null,
    ),
    "description",
  ),
  ic(
    C.str("html_url", "Link to the issue in the Jira UI (<site>/browse/<key>).", (r) =>
      r.__ctx?.browse && r.key ? `${r.__ctx.browse}${r.key}` : null,
    ),
  ),
  ic(
    C.time("created_at", "When the issue was created. Ranges push down (created).", (r) => F(r).created),
    "created",
  ),
  ic(
    C.time("updated_at", "When the issue last changed. Ranges push down (updated).", (r) => F(r).updated),
    "updated",
  ),
  ic(
    C.time(
      "closed_at",
      "Resolution date; NULL while unresolved (aligned with GitHub/GitLab 'closed_at'). Ranges push down (resolved).",
      (r) => F(r).resolutiondate,
    ),
    "resolutiondate",
  ),
  ic(
    C.time(
      "status_category_changed_at",
      "When the status category last changed.",
      (r) => F(r).statuscategorychangedate,
    ),
    "statuscategorychangedate",
  ),
  ic(
    C.json(
      "custom_fields",
      "Every non-empty custom field as a JSON object keyed by field name (raw Jira values). Hoist fields into typed columns with the custom_fields ATTACH option.",
      (r) => r.__custom ?? null,
    ),
    CUSTOM,
  ),
];

/** WHERE column → JQL field. */
function issueFieldMap(dep: Deployment): Record<string, FieldMap> {
  const m: Record<string, FieldMap> = {
    repo: { field: "project", kind: "string", ne: true },
    project_key: { field: "project", kind: "string", ne: true },
    key: { field: "key", kind: "string" },
    id: { field: "id", kind: "number" },
    status: { field: "status", kind: "string", ne: true },
    status_category: { field: "statusCategory", kind: "string", ne: true },
    state: {
      field: "statusCategory",
      kind: "state",
      clause: (op, v) => {
        if (v !== "open" && v !== "closed") return undefined;
        if (op !== "eq" && op !== "ne") return undefined;
        return (v === "closed") === (op === "eq") ? "statusCategory = Done" : "statusCategory != Done";
      },
    },
    issue_type: { field: "issuetype", kind: "string", ne: true },
    is_subtask: {
      field: "issuetype",
      kind: "state",
      clause: (op, v) =>
        op === "eq" && typeof v === "boolean"
          ? v
            ? "issuetype in subTaskIssueTypes()"
            : "issuetype in standardIssueTypes()"
          : undefined,
    },
    priority: { field: "priority", kind: "string", empty: true },
    resolution: { field: "resolution", kind: "string", empty: true },
    user_login: { field: "reporter", kind: "string", empty: true },
    assignee: { field: "assignee", kind: "string", empty: true },
    assignees: { field: "assignee", kind: "list" },
    labels: { field: "labels", kind: "list" },
    components: { field: "component", kind: "list" },
    fix_versions: { field: "fixVersion", kind: "list" },
    affects_versions: { field: "affectedVersion", kind: "list" },
    sprint_ids: { field: "sprint", kind: "list" },
    created_at: { field: "created", kind: "time" },
    updated_at: { field: "updated", kind: "time" },
    closed_at: { field: "resolved", kind: "time" },
  };
  // Data Center's `parent` only covers sub-tasks (epics use "Epic Link"): never narrow there.
  if (dep === "cloud") m.parent_key = { field: "parent", kind: "string", empty: true };
  return m;
}

// ------------------------------------------------------------- hoisted custom fields

const HOIST_TYPES: Record<string, { type: VgiDataType; sql: string; conv: (v: unknown) => unknown }> = {};

/** Reduce a Jira field value to something scalar: option → value, user → displayName, … */
export function simplify(v: unknown): unknown {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(simplify);
  if (typeof v === "object") {
    const r = v as Row;
    for (const k of ["value", "name", "displayName", "key", "id"]) if (r[k] != null) return r[k];
    return JSON.stringify(v);
  }
  return v;
}
const scalarOf = (v: unknown) => {
  const s = simplify(v);
  return Array.isArray(s) ? (s.length ? s.join(", ") : null) : s;
};
HOIST_TYPES.VARCHAR = { type: utf8(), sql: "VARCHAR", conv: (v) => asStr(scalarOf(v)) };
HOIST_TYPES.DOUBLE = { type: float64(), sql: "DOUBLE", conv: (v) => asNum(scalarOf(v)) };
HOIST_TYPES.BIGINT = { type: int64(), sql: "BIGINT", conv: (v) => asBig(scalarOf(v)) };
HOIST_TYPES.BOOLEAN = { type: bool, sql: "BOOLEAN", conv: (v) => asBool(scalarOf(v)) };
HOIST_TYPES.DATE = { type: dateDay(), sql: "DATE", conv: (v) => asDate(scalarOf(v)) };
HOIST_TYPES.TIMESTAMPTZ = {
  type: timestampMicros("UTC"),
  sql: "TIMESTAMP WITH TIME ZONE",
  conv: (v) => asTime(scalarOf(v)),
};
HOIST_TYPES["VARCHAR[]"] = {
  type: list(utf8()),
  sql: "VARCHAR[]",
  conv: (v) => {
    if (v == null) return null;
    const s = simplify(v);
    return (Array.isArray(s) ? s : [s]).filter((x) => x != null).map((x) => String(x));
  },
};
HOIST_TYPES.JSON = { type: utf8(), sql: "JSON", conv: (v) => asJson(v) };
const TYPE_ALIASES: Record<string, string> = {
  TEXT: "VARCHAR",
  STRING: "VARCHAR",
  FLOAT: "DOUBLE",
  NUMBER: "DOUBLE",
  NUMERIC: "DOUBLE",
  INTEGER: "BIGINT",
  INT: "BIGINT",
  BOOL: "BOOLEAN",
  TIMESTAMP: "TIMESTAMPTZ",
  "TIMESTAMP WITH TIME ZONE": "TIMESTAMPTZ",
  LIST: "VARCHAR[]",
};

export interface Hoist {
  column: string;
  ref: string;
  type: string;
}

/** Parse `col=Field Name[:TYPE], col2=customfield_10030` (the custom_fields ATTACH option). */
export function parseHoists(spec: unknown): Hoist[] {
  if (typeof spec !== "string" || !spec.trim()) return [];
  const taken = new Set(ISSUE_COLUMNS.map((c) => c.name));
  const out: Hoist[] = [];
  for (const raw of spec.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)(?:\s*:\s*([A-Za-z][A-Za-z [\]]*))?$/.exec(entry);
    if (!m) {
      throw new AtlassianError(
        `custom_fields ATTACH option: cannot parse '${entry}' (expected column=Field name or customfield_NNNNN[:TYPE])`,
      );
    }
    const column = (m[1] as string).toLowerCase();
    const t = (m[3] ?? "VARCHAR").trim().toUpperCase();
    const type = TYPE_ALIASES[t] ?? t;
    if (!HOIST_TYPES[type]) {
      throw new AtlassianError(
        `custom_fields ATTACH option: type '${t}' for ${column} is not one of ${Object.keys(HOIST_TYPES).join(", ")}`,
      );
    }
    if (taken.has(column)) throw new AtlassianError(`custom_fields ATTACH option: column '${column}' already exists`);
    taken.add(column);
    out.push({ column, ref: (m[2] as string).trim(), type });
  }
  return out;
}

function hoistColumn(h: Hoist): IssueCol {
  const t = HOIST_TYPES[h.type] as (typeof HOIST_TYPES)[string];
  return {
    name: h.column,
    type: t.type,
    sqlType: t.sql,
    doc: `Custom field '${h.ref}' (hoisted by the custom_fields ATTACH option).`,
    nullable: true,
    get: (r) => t.conv((r.__hoist as Record<string, unknown> | undefined)?.[h.column]),
    fields: [`@hoist:${h.column}`],
    ref: h.ref,
  };
}

function columnsFor(attachData: Uint8Array | null | undefined): IssueCol[] {
  let opt: unknown;
  try {
    opt = attachOption(attachData, "custom_fields");
  } catch {
    opt = undefined;
  }
  return [...ISSUE_COLUMNS, ...parseHoists(opt).map(hoistColumn)];
}

// ------------------------------------------------------------------------ function

/** The first clause of a column doc, for the size-bounded result-columns tag. */
function shortDoc(doc: string): string {
  const first = doc.split(/(?<=[.;])\s|\s\(|—/)[0] ?? doc;
  const s = first.replace(/[.;]$/, "").trim();
  return s.length > 48 ? `${s.slice(0, 47).trimEnd()}…` : s;
}

const PUSHDOWN_MD =
  "project/repo (= / IN / !=), key (= / IN), id, status, status_category, state ('open' → " +
  "statusCategory != Done), issue_type, is_subtask, priority, resolution, assignee, user_login " +
  "(reporter) — = / IN and IS NULL (→ is EMPTY) where meaningful; list_contains on labels, components, " +
  "fix_versions, affects_versions, assignees and sprint_ids; parent_key (Cloud); created_at / " +
  "updated_at / closed_at ranges (widened by a day for JQL's minute precision and user time zone, " +
  "then re-checked exactly); hoisted numeric custom fields (= and ranges via cf[id]). All clauses are " +
  "ANDed with the jql argument. The projection becomes the fields= parameter.";

interface IssueState {
  next: string;
  done: boolean;
}

export const issues: VgiFunction = defineTableFunction<{ jql: string | null; page_size: bigint | number }, IssueState>({
  name: "issues",
  description:
    "Jira issues matching a JQL search, with SQL filters pushed into the JQL and only selected fields fetched.",
  args: { jql: utf8(), page_size: int64() },
  argDocs: {
    jql: "Optional JQL (named). ANDed with the clauses generated from WHERE; its ORDER BY is kept.",
    page_size: "Issues per request (named, 1-100; default 100).",
  },
  argDefaults: { jql: null, page_size: 100 },
  argConstraints: { page_size: { ge: 1, le: 100 } },
  filterPushdown: true,
  projectionPushdown: true,
  autoApplyFilters: true,
  onBind: (params) => {
    const outputSchema = schemaOf(columnsFor(params.bindCall.attach_opaque_data));
    return params.resolvedSecretsProvided ? { outputSchema } : { outputSchema, lookupSecretTypes: [SECRET_TYPE] };
  },
  initialState: () => ({ next: "", done: false }),
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const cfg = configFromSecrets(params.secrets);
    const dep = await resolveDeployment(cfg);
    const columns = columnsFor(params.initCall.bind_call.attach_opaque_data);
    const constraints0 = constraintsOf(params.pushdownFilters);
    const needed0 = neededColumns(params.outputSchema, constraints0);
    // Only the hoisted columns this query reads need resolving against the field catalogue.
    const hoists = columns.filter((c) => c.fields[0]?.startsWith("@hoist:") && needed0.has(c.name));
    const constraints = constraints0;
    const needed = needed0;
    log.debug(`issues: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);

    // fields= from the needed columns; resolve catalogue-backed placeholders.
    const want = new Set<string>();
    for (const c of columns) if (needed.has(c.name)) for (const f of c.fields) want.add(f);
    let catalogue: JiraField[] = [];
    const needsCatalogue = [...want].some((f) => f.startsWith("@"));
    if (needsCatalogue) catalogue = await jiraFields(cfg, dep);
    const sprintId = sprintFieldId(catalogue);
    const hoistField = new Map<string, JiraField>();
    for (const h of hoists) {
      const ref = h.ref ?? "";
      const f = findField(catalogue, ref);
      if (!f) throw new AtlassianError(`custom_fields ATTACH option: no Jira field named '${ref}' on this site`);
      hoistField.set(h.name, f);
    }
    const customs = catalogue.filter((f) => f.custom);
    const fields: string[] = [];
    for (const f of want) {
      if (f === SPRINT) {
        if (sprintId) fields.push(sprintId);
      } else if (f === CUSTOM) {
        if (customs.length > 100) fields.push("*all");
        else fields.push(...customs.map((c) => c.id));
      } else if (f.startsWith("@hoist:")) {
        const hf = hoistField.get(f.slice(7));
        if (hf) fields.push(hf.id);
      } else fields.push(f);
    }

    const fmap = issueFieldMap(dep);
    for (const [col, f] of hoistField) {
      const h = hoists.find((x) => x.name === col);
      const m = /^customfield_(\d+)$/.exec(f.id);
      if (m && (h?.sqlType === "DOUBLE" || h?.sqlType === "BIGINT")) {
        fmap[col] = { field: `cf[${m[1]}]`, kind: "number", range: true };
      }
    }
    const jql = andJoin(params.args.jql, buildClauses(constraints, fmap), "ORDER BY key ASC");
    const size = Math.min(100, Math.max(1, Number(params.args.page_size ?? 100)));
    const req = searchRequest(cfg, dep, jql, fields, size);
    log.debug(`issues: ${req.url}`);

    const page = parsePage(cfg, req, state.next || req.url, await atlassianGet(cfg, state.next || req.url));
    if (page.next) state.next = page.next;
    else state.done = true;

    const browse = `${cfg.siteUrl}/browse/`;
    const customName = new Map<string, string>();
    for (const c of customs) {
      const dup = customs.filter((x) => x.name === c.name).length > 1;
      customName.set(c.id, dup ? `${c.name} (${c.id})` : c.name);
    }
    const rows: Row[] = page.rows.map((r) => {
      const f = F(r);
      const row: Row = { ...r, __ctx: { browse } };
      if (sprintId && Array.isArray(f[sprintId])) row.__sprints = (f[sprintId] as unknown[]).map(parseSprint);
      else if (sprintId && want.has(SPRINT)) row.__sprints = [];
      if (want.has(CUSTOM)) {
        const m: Record<string, unknown> = {};
        for (const [id, v] of Object.entries(f)) {
          const nm = customName.get(id);
          if (nm && v != null && !(Array.isArray(v) && v.length === 0)) m[nm] = v;
        }
        row.__custom = m;
      }
      if (hoistField.size) {
        const hv: Record<string, unknown> = {};
        for (const [col, hf] of hoistField) hv[col] = f[hf.id];
        row.__hoist = hv;
      }
      return row;
    });
    if (rows.length) emitRows(out as never, params.initCall.output_schema, columns, rows, needed);
    if (state.done) out.finish();
  },
  tags: {
    domain: "project management",
    ...objectTags({
      title: "Jira Issues",
      category: "issues",
      keywords: "jira, issues, jql, tickets, bugs, stories, epics, backlog, search, cycle time",
      docLlm:
        "issues(jql := NULL, page_size := 100) runs a Jira JQL search (Cloud enhanced search " +
        "/rest/api/3/search/jql, or /rest/api/2/search on Data Center) and returns one row per issue. " +
        "Prefer plain SQL WHERE filters: they are translated to JQL — " +
        PUSHDOWN_MD +
        " Use jql := for anything SQL cannot express (text ~, functions such as openSprints(), " +
        "currentUser(), was/changed history predicates). Columns: repo/project_key, number, key, id, " +
        "title/summary, state ('open'/'closed'), status, status_category, issue_type, is_subtask, " +
        "priority, resolution, user_login (reporter id), reporter_display_name, assignee (accountId on " +
        "Cloud, username on DC), assignee_display_name, assignees, labels, components, fix_versions, " +
        "affects_versions, parent_key, sprint_ids, sprint_names, due_date, estimates/time spent in " +
        "seconds, votes, watches, body (plain text), description_adf, html_url, created_at, updated_at, " +
        "closed_at (resolution date), custom_fields (JSON by field name) plus any columns hoisted via the " +
        "custom_fields ATTACH option. Names match the GitHub/GitLab workers for UNIONs.",
      docMd:
        "## issues(jql := NULL, page_size := 100)\n\n" +
        "Jira issues from a JQL search. SQL filters are translated into JQL and ANDed with `jql`; only " +
        "the selected columns' fields are requested.\n\n" +
        "Hoist custom fields into typed columns at ATTACH time:\n\n" +
        "```sql\nATTACH 'jira' (TYPE vgi, LOCATION '…', custom_fields 'story_points=Story point estimate:DOUBLE, team=Team');\n```\n\n" +
        `**Pushdown:** ${PUSHDOWN_MD}`,
    }),
    // Names and types only: the full column docs are the schema's column comments
    // (the descriptions together exceed what agent tools show for one tag).
    "vgi.result_columns_schema": JSON.stringify(
      ISSUE_COLUMNS.map((c) => ({ name: c.name, type: c.sqlType, description: shortDoc(c.doc) })),
    ),
  },
  examples: [
    {
      description: "Open bugs in a project by priority (one JQL request: project, issuetype, statusCategory)",
      sql: "SELECT key, title, priority, assignee_display_name FROM jira.main.issues() WHERE project_key = 'ENG' AND issue_type = 'Bug' AND state = 'open' ORDER BY priority, key",
    },
    {
      description: 'Issues per status category for one label (list_contains becomes labels = "backend")',
      sql: "SELECT status_category, count(*) AS issues FROM jira.main.issues() WHERE list_contains(labels, 'backend') GROUP BY status_category ORDER BY status_category",
    },
    {
      description: "Combine raw JQL with SQL filters: recently resolved issues of the current sprint",
      sql: "SELECT key, closed_at FROM jira.main.issues(jql := 'sprint in openSprints()') WHERE closed_at >= TIMESTAMPTZ '2026-11-01' ORDER BY closed_at",
    },
  ],
});
