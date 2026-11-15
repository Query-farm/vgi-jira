/**
 * The Jira collections other than `issues`: per-issue history/comments/worklogs/links,
 * per-project components/versions/statuses, boards and sprints, and site metadata.
 */

import { int64, utf8, type VgiFunction } from "@query-farm/vgi";
import { eqValues } from "../atlassian/pushdown.ts";
import {
  C,
  type Col,
  defineAtlassianTable,
  defineCatalogTable,
  type PageRequest,
  type Plan,
  type Row,
  type ScanContext,
  type TableSpec,
  withQuery,
} from "../atlassian/table.ts";
import { adfToText } from "../atlassian/text.ts";
import { agile, api, issueKeys, keysJql, searchRequest, userId, userName } from "./common.ts";

const enc = encodeURIComponent;

// ----------------------------------------------------------------- per-issue fan-out

interface IssueArgs extends Record<string, unknown> {
  issue_key: string | null;
  jql: string | null;
}

const ISSUE_ARGS = {
  args: { issue_key: utf8(), jql: utf8() },
  argDocs: {
    issue_key: "Issue key, or comma-separated keys (named). A WHERE issue_key = / IN filter works too.",
    jql: "JQL selecting the issues to read (named), ANDed with any issue_key filter. Without either, every issue is read.",
  },
  argDefaults: { issue_key: null, jql: null },
};

/** Explicit keys → read each; otherwise list the issues a JQL search matches, then read each. */
function perIssue(scan: ScanContext<IssueArgs>, child: (key: string) => PageRequest): Plan {
  const keys = issueKeys(scan.constraints, "issue_key", scan.args.issue_key);
  if (keys && !scan.args.jql) return { kind: "fanout", ids: keys, parents: [], parentId: () => null, child };
  return {
    kind: "fanout",
    parents: [searchRequest(scan.cfg, scan.deployment, keysJql(keys, scan.args.jql), ["id"], 100)],
    parentId: (r) => (typeof r.key === "string" ? r.key : null),
    child,
  };
}

const ISSUE_KEY_COL = C.str(
  "issue_key",
  "Key of the issue (pushed down: = / IN reads only those issues).",
  "issue_key",
  false,
);

// --------------------------------------------------------------------- changelog

/** One row per changed field of each changelog history entry. */
function flattenHistories(histories: Row[], issueKey: string): Row[] {
  const out: Row[] = [];
  for (const h of histories) for (const item of (h.items ?? []) as Row[]) out.push({ ...h, item, issue_key: issueKey });
  return out;
}

const changelog: VgiFunction = defineAtlassianTable<IssueArgs>({
  name: "issue_changelog",
  product: "jira",
  ...ISSUE_ARGS,
  description:
    "Field-level change history of Jira issues: status transitions, reassignments, edits (one row per changed field).",
  title: "Issue Changelog",
  category: "issues",
  keywords: "jira, changelog, history, status transitions, cycle time, lead time, audit",
  docLlm:
    "issue_changelog(issue_key := NULL, jql := NULL) returns one row per changed field per changelog " +
    "entry: issue_key, history_id, author (accountId / DC username), author_display_name, changed_at, " +
    "field (e.g. 'status', 'assignee', 'Sprint'), field_id, field_type, from_value / from_string, " +
    "to_value / to_string. For status transitions and cycle time filter WHERE field = 'status' and use " +
    "from_string / to_string with changed_at. Pass issue_key (or WHERE issue_key IN (…)) for specific " +
    "issues; otherwise jql picks the issues (every issue when omitted). Cloud pages " +
    "/rest/api/3/issue/{key}/changelog; Data Center reads the search with expand=changelog.",
  docMd:
    "## issue_changelog(issue_key := NULL, jql := NULL)\n\nOne row per changed field per history entry " +
    "— status transitions (`field = 'status'`), reassignments, sprint moves and edits.",
  pushdown: "issue_key = / IN selects the issues; jql is a JQL search for them.",
  columns: [
    ISSUE_KEY_COL,
    C.str("history_id", "Changelog entry id (several fields can change in one entry).", "id", false),
    C.str("author", "Who made the change: accountId (Cloud) or username (Data Center).", (r) => userId(r.author)),
    C.str("author_display_name", "Display name of who made the change.", (r) => userName(r.author)),
    C.time("changed_at", "When the change was made.", "created"),
    C.str("field", "Changed field name as shown in the history (status, assignee, Sprint, …).", "item.field"),
    C.str("field_id", "Changed field id (Cloud), e.g. status or customfield_10020.", "item.fieldId"),
    C.str("field_type", "'jira' for system fields, 'custom' for custom fields.", "item.fieldtype"),
    C.str("from_value", "Previous raw value (an id for status/user fields).", "item.from"),
    C.str("from_string", "Previous value as displayed (e.g. 'To Do').", "item.fromString"),
    C.str("to_value", "New raw value.", "item.to"),
    C.str("to_string", "New value as displayed (e.g. 'In Progress').", "item.toString"),
  ],
  plan: (scan) => {
    if (scan.deployment === "datacenter") {
      const keys = issueKeys(scan.constraints, "issue_key", scan.args.issue_key);
      return {
        kind: "phases",
        phases: [
          searchRequest(scan.cfg, scan.deployment, keysJql(keys, scan.args.jql), ["id"], 50, { expand: "changelog" }),
        ],
      };
    }
    return perIssue(scan, (key) => ({
      url: withQuery(api(scan.cfg, "cloud", `/issue/${enc(key)}/changelog`), { maxResults: "100" }),
      paging: { style: "offset", key: "values" },
      ctx: { issue_key: key },
    }));
  },
  rows: (rows, scan, ctx) =>
    scan.deployment === "datacenter"
      ? rows.flatMap((issue) => flattenHistories((issue.changelog?.histories ?? []) as Row[], issue.key))
      : flattenHistories(rows, ctx.issue_key ?? ""),
  emptyOn: [404],
  examples: [
    {
      description: "Status transitions of one issue in order (cycle-time building block)",
      sql: "SELECT changed_at, from_string, to_string, author_display_name FROM jira.main.issue_changelog(issue_key := 'ENG-1') WHERE field = 'status' ORDER BY changed_at",
    },
    {
      description: "Hours each issue of a project spent In Progress, from consecutive status changes",
      sql: "SELECT issue_key, sum(epoch(next_at - changed_at)) / 3600 AS hours_in_progress FROM (SELECT issue_key, changed_at, to_string, lead(changed_at) OVER (PARTITION BY issue_key ORDER BY changed_at) AS next_at FROM jira.main.issue_changelog(jql := 'project = ENG') WHERE field = 'status') WHERE to_string = 'In Progress' AND next_at IS NOT NULL GROUP BY issue_key ORDER BY issue_key",
    },
  ],
});

// ---------------------------------------------------------------------- comments

const comments: VgiFunction = defineAtlassianTable<IssueArgs>({
  name: "issue_comments",
  product: "jira",
  ...ISSUE_ARGS,
  description: "Comments on Jira issues, with the body as plain text and as raw ADF JSON.",
  title: "Issue Comments",
  category: "issues",
  keywords: "jira, comments, discussion, adf, issue comments",
  docLlm:
    "issue_comments(issue_key := NULL, jql := NULL) returns one row per comment: issue_key, id, author, " +
    "author_display_name, body (plain text extracted from ADF on Cloud, wiki markup on Data Center), " +
    "body_adf (raw ADF JSON, Cloud only), created_at, updated_at, visibility (e.g. 'role:Developers' " +
    "for restricted comments), is_public (Jira Service Management). Select issues with issue_key " +
    "(or WHERE issue_key = / IN) or jql.",
  docMd: "## issue_comments(issue_key := NULL, jql := NULL)\n\nComments with plain-text and ADF bodies.",
  pushdown: "issue_key = / IN selects the issues; jql is a JQL search for them.",
  columns: [
    ISSUE_KEY_COL,
    C.big("id", "Comment id.", "id", false),
    C.str("author", "Author accountId (Cloud) or username (Data Center).", (r) => userId(r.author)),
    C.str("author_display_name", "Author display name.", (r) => userName(r.author)),
    C.str("body", "Comment as plain text.", (r) => adfToText(r.body)),
    C.json("body_adf", "Comment as raw ADF JSON (Cloud); NULL on Data Center.", (r) =>
      typeof r.body === "object" ? r.body : null,
    ),
    C.time("created_at", "When the comment was posted.", "created"),
    C.time("updated_at", "When the comment was last edited.", "updated"),
    C.str("visibility", "Restriction as type:value (e.g. role:Developers); NULL when visible to all.", (r) =>
      r.visibility ? `${r.visibility.type}:${r.visibility.value ?? r.visibility.identifier ?? ""}` : null,
    ),
    C.bool("is_public", "Jira Service Management: whether customers can see the comment.", "jsdPublic"),
  ],
  plan: (scan) =>
    perIssue(scan, (key) => ({
      url: withQuery(api(scan.cfg, scan.deployment, `/issue/${enc(key)}/comment`), { maxResults: "100" }),
      paging: { style: "offset", key: "comments" },
      ctx: { issue_key: key },
    })),
  rows: (rows, _s, ctx) => rows.map((r) => ({ ...r, issue_key: ctx.issue_key })),
  emptyOn: [404],
  examples: [
    {
      description: "Most talkative commenters in a project",
      sql: "SELECT author_display_name, count(*) AS comments FROM jira.main.issue_comments(jql := 'project = ENG') GROUP BY author_display_name ORDER BY comments DESC",
    },
    {
      description: "Read one issue's discussion as text",
      sql: "SELECT created_at, author_display_name, body FROM jira.main.issue_comments(issue_key := 'ENG-1') ORDER BY created_at",
    },
  ],
});

// ---------------------------------------------------------------------- worklogs

const worklogs: VgiFunction = defineAtlassianTable<IssueArgs>({
  name: "issue_worklogs",
  product: "jira",
  ...ISSUE_ARGS,
  description: "Time logged on Jira issues (worklogs).",
  title: "Issue Worklogs",
  category: "issues",
  keywords: "jira, worklogs, time tracking, hours, timesheet, effort",
  docLlm:
    "issue_worklogs(issue_key := NULL, jql := NULL) returns one row per worklog: issue_key, id, author, " +
    "author_display_name, started_at, time_spent_seconds, time_spent (as entered, e.g. '3h 20m'), " +
    "comment (plain text), created_at, updated_at. Sum time_spent_seconds / 3600 for hours.",
  docMd: "## issue_worklogs(issue_key := NULL, jql := NULL)\n\nWorklogs: who logged how much time, when.",
  pushdown: "issue_key = / IN selects the issues; jql is a JQL search for them.",
  columns: [
    ISSUE_KEY_COL,
    C.big("id", "Worklog id.", "id", false),
    C.str("author", "Author accountId (Cloud) or username (Data Center).", (r) => userId(r.author)),
    C.str("author_display_name", "Author display name.", (r) => userName(r.author)),
    C.time("started_at", "When the work started.", "started"),
    C.big("time_spent_seconds", "Time spent in seconds.", "timeSpentSeconds"),
    C.str("time_spent", "Time spent as entered (e.g. 3h 20m).", "timeSpent"),
    C.str("comment", "Worklog comment as plain text.", (r) => adfToText(r.comment)),
    C.time("created_at", "When the worklog was created.", "created"),
    C.time("updated_at", "When the worklog was last updated.", "updated"),
  ],
  plan: (scan) =>
    perIssue(scan, (key) => ({
      url: withQuery(api(scan.cfg, scan.deployment, `/issue/${enc(key)}/worklog`), { maxResults: "1000" }),
      paging: { style: "offset", key: "worklogs" },
      ctx: { issue_key: key },
    })),
  rows: (rows, _s, ctx) => rows.map((r) => ({ ...r, issue_key: ctx.issue_key })),
  emptyOn: [404],
  examples: [
    {
      description: "Hours logged per person on one issue",
      sql: "SELECT author_display_name, sum(time_spent_seconds) / 3600.0 AS hours FROM jira.main.issue_worklogs(issue_key := 'ENG-2') GROUP BY author_display_name ORDER BY hours DESC",
    },
  ],
});

// ------------------------------------------------------------------------- links

const links: VgiFunction = defineAtlassianTable<{ jql: string | null }>({
  name: "issue_links",
  product: "jira",
  args: { jql: utf8() },
  argDocs: {
    jql: "JQL selecting the issues whose links to list (named). Without it (and without an issue_key filter) every issue is read.",
  },
  argDefaults: { jql: null },
  description: "Links between Jira issues (blocks, relates to, duplicates …), one row per link end.",
  title: "Issue Links",
  category: "issues",
  keywords: "jira, issue links, dependencies, blocks, blocked by, duplicates, relates",
  docLlm:
    "issue_links(jql := NULL) returns one row per link of each issue: issue_key, link_id, link_type " +
    "(e.g. Blocks), direction ('outward' when issue_key is the source, 'inward' when it is the target), " +
    "relationship (the phrase from issue_key's side, e.g. 'blocks' or 'is blocked by'), linked_issue_key, " +
    "linked_issue_summary, linked_issue_status, linked_issue_type. WHERE issue_key = / IN pushes into " +
    "the JQL. Read from the issuelinks field of a JQL search (one request per page of issues).",
  docMd: "## issue_links(jql := NULL)\n\nIssue link graph: blockers, duplicates, relations.",
  pushdown: "issue_key = / IN → JQL key in (…), ANDed with jql.",
  columns: [
    C.str("issue_key", "The issue whose link this is (pushed down: = / IN).", "issue_key", false),
    C.str("link_id", "Link id (the same link appears once from each end).", "link.id", false),
    C.str("link_type", "Link type name (Blocks, Relates, Duplicate, Cloners …).", "link.type.name"),
    C.str("direction", "'outward' (issue_key → linked issue) or 'inward' (linked issue → issue_key).", "direction"),
    C.str("relationship", "The link phrase from issue_key's side, e.g. 'blocks' or 'is blocked by'.", (r) =>
      r.direction === "outward" ? r.link?.type?.outward : r.link?.type?.inward,
    ),
    C.str("linked_issue_key", "Key of the issue at the other end.", "other.key"),
    C.str("linked_issue_summary", "Summary of the linked issue.", "other.fields.summary"),
    C.str("linked_issue_status", "Status of the linked issue.", "other.fields.status.name"),
    C.str("linked_issue_type", "Issue type of the linked issue.", "other.fields.issuetype.name"),
  ],
  plan: (scan) => ({
    kind: "phases",
    phases: [
      searchRequest(
        scan.cfg,
        scan.deployment,
        keysJql(eqValues(scan.constraints, "issue_key"), scan.args.jql),
        ["issuelinks"],
        100,
      ),
    ],
  }),
  rows: (rows) =>
    rows.flatMap((issue) =>
      ((issue.fields?.issuelinks ?? []) as Row[]).map((link) => ({
        issue_key: issue.key,
        link,
        direction: link.outwardIssue ? "outward" : "inward",
        other: link.outwardIssue ?? link.inwardIssue,
      })),
    ),
  examples: [
    {
      description: "Open issues that are blocked, and by what",
      sql: "SELECT issue_key, linked_issue_key, linked_issue_status FROM jira.main.issue_links(jql := 'statusCategory != Done') WHERE relationship = 'is blocked by' ORDER BY issue_key",
    },
  ],
});

// ----------------------------------------------------------------------- projects

function projectsRequest(scan: ScanContext<Record<string, unknown>>, keys?: string[]): PageRequest {
  if (scan.deployment === "cloud") {
    const u = new URL(
      withQuery(api(scan.cfg, "cloud", "/project/search"), { maxResults: "50", expand: "description,lead" }),
    );
    for (const k of keys ?? []) u.searchParams.append("keys", k);
    return { url: u.toString(), paging: { style: "offset", key: "values" } };
  }
  return {
    url: withQuery(api(scan.cfg, "datacenter", "/project"), { expand: "description,lead" }),
    paging: { style: "array" },
  };
}

const projects = defineCatalogTable(
  {
    name: "projects",
    product: "jira",
    description: "Jira projects visible to the secret's user.",
    title: "Jira Projects",
    category: "projects",
    keywords: "jira, projects, project keys, leads, categories",
    docLlm:
      "projects lists Jira projects: id, key, name, project_type (software / business / " +
      "service_desk), style ('classic' company-managed, 'next-gen' team-managed; Cloud), category, " +
      "lead (accountId / username), lead_display_name, description, is_private, html_url. On Cloud a " +
      "WHERE key = / IN filter is sent as keys= to /rest/api/3/project/search.",
    docMd: "## projects\n\nJira projects with type, style, category and lead.",
    pushdown: "key = / IN (Cloud: keys=).",
    primaryKey: "id",
    columns: [
      C.str("id", "Project id.", "id", false),
      C.str("key", "Project key (ENG). Pushed down on Cloud.", "key"),
      C.str("name", "Project name.", "name"),
      C.str("project_type", "software, business or service_desk.", "projectTypeKey"),
      C.str("style", "classic (company-managed) or next-gen (team-managed); Cloud only.", "style"),
      C.str("category", "Project category name.", "projectCategory.name"),
      C.str("lead", "Project lead accountId (Cloud) or username (Data Center).", (r) => userId(r.lead)),
      C.str("lead_display_name", "Project lead display name.", (r) => userName(r.lead)),
      C.str("description", "Project description.", "description"),
      C.bool("is_private", "Whether the project is private (Cloud).", "isPrivate"),
      C.str("html_url", "Link to the project in the Jira UI.", (r) =>
        r.key ? `${r.__ctx?.browse ?? ""}${r.key}` : null,
      ),
    ],
    plan: (scan) => {
      const req = projectsRequest(scan as never, eqValues(scan.constraints, "key"));
      return { kind: "phases", phases: [{ ...req, ctx: { browse: `${scan.cfg.siteUrl}/browse/` } }] };
    },
    examples: [
      {
        description: "Software projects and their leads",
        sql: "SELECT key, name, lead_display_name FROM jira.main.projects WHERE project_type = 'software' ORDER BY key",
      },
    ],
  },
  "main",
);

// --------------------------------------------------------- per-project collections

interface ProjectArgs extends Record<string, unknown> {
  project_key: string | null;
}

function perProject(scan: ScanContext<ProjectArgs>, child: (key: string) => PageRequest): Plan {
  const arg = scan.args.project_key;
  const ids = typeof arg === "string" && arg ? [arg] : eqValues(scan.constraints, "project_key");
  return {
    kind: "fanout",
    ids,
    parents: [projectsRequest(scan as never)],
    parentId: (r) => (typeof r.key === "string" ? r.key : null),
    child,
  };
}

function projectSpec(
  name: string,
  over: Omit<TableSpec<ProjectArgs>, "name" | "product" | "args" | "argDocs" | "argDefaults" | "category" | "plan"> & {
    path: (key: string) => string;
  },
): VgiFunction {
  const { path, ...rest } = over;
  return defineAtlassianTable<ProjectArgs>({
    ...rest,
    name,
    product: "jira",
    category: "projects",
    args: { project_key: utf8() },
    argDocs: {
      project_key: "Project key (named). A WHERE project_key = / IN filter works too; otherwise every project is read.",
    },
    argDefaults: { project_key: null },
    pushdown: "project_key = / IN reads only those projects.",
    plan: (scan) =>
      perProject(scan, (key) => ({
        url: api(scan.cfg, scan.deployment, path(enc(key))),
        paging: { style: "array" },
        ctx: { project_key: key },
      })),
    emptyOn: [404],
  });
}

const PROJECT_KEY_COL = C.ctx("project_key", "Project key (pushed down: = / IN).", "project_key");

const components = projectSpec("components", {
  description: "Components of Jira projects.",
  title: "Project Components",
  keywords: "jira, components, modules, component leads, ownership",
  docLlm:
    "components(project_key := NULL) lists project components: project_key, id, name, description, " +
    "lead (accountId / username), lead_display_name, assignee_type (default assignee rule).",
  docMd: "## components(project_key := NULL)\n\nProject components and their leads.",
  path: (k) => `/project/${k}/components`,
  columns: [
    PROJECT_KEY_COL,
    C.str("id", "Component id.", "id", false),
    C.str("name", "Component name.", "name"),
    C.str("description", "Component description.", "description"),
    C.str("lead", "Component lead accountId (Cloud) or username (Data Center).", (r) => userId(r.lead)),
    C.str("lead_display_name", "Component lead display name.", (r) => userName(r.lead)),
    C.str(
      "assignee_type",
      "Default assignee rule: PROJECT_DEFAULT, COMPONENT_LEAD, PROJECT_LEAD, UNASSIGNED.",
      "assigneeType",
    ),
  ],
  examples: [
    {
      description: "Components of a project with their leads",
      sql: "SELECT name, lead_display_name FROM jira.main.components(project_key := 'ENG') ORDER BY name",
    },
  ],
});

const versions = projectSpec("versions", {
  description: "Versions (releases) of Jira projects.",
  title: "Project Versions",
  keywords: "jira, versions, releases, fix versions, release dates, roadmap",
  docLlm:
    "versions(project_key := NULL) lists project versions: project_key, id, name, description, released, " +
    "archived, overdue, start_date, release_date (`DATE`).",
  docMd: "## versions(project_key := NULL)\n\nReleases with their dates and state.",
  path: (k) => `/project/${k}/versions`,
  columns: [
    PROJECT_KEY_COL,
    C.str("id", "Version id.", "id", false),
    C.str("name", "Version name.", "name"),
    C.str("description", "Version description.", "description"),
    C.bool("released", "Whether the version is released.", "released"),
    C.bool("archived", "Whether the version is archived.", "archived"),
    C.bool("overdue", "Whether the release date has passed while unreleased.", "overdue"),
    C.date("start_date", "Start date.", "startDate"),
    C.date("release_date", "Release date.", "releaseDate"),
  ],
  examples: [
    {
      description: "Unreleased versions by release date",
      sql: "SELECT project_key, name, release_date FROM jira.main.versions() WHERE NOT released ORDER BY release_date",
    },
  ],
});

const projectStatuses = projectSpec("project_statuses", {
  description: "Workflow statuses available per issue type in Jira projects.",
  title: "Project Workflow Statuses",
  keywords: "jira, workflow, statuses, issue types, status categories",
  docLlm:
    "project_statuses(project_key := NULL) lists, per project and issue type, the statuses its workflow " +
    "uses: project_key, issue_type, issue_type_id, is_subtask, status_id, status, status_category, " +
    "status_category_key (new / indeterminate / done).",
  docMd: "## project_statuses(project_key := NULL)\n\nWhich statuses each issue type's workflow uses.",
  path: (k) => `/project/${k}/statuses`,
  columns: [
    PROJECT_KEY_COL,
    C.str("issue_type", "Issue type name.", "issue_type.name"),
    C.str("issue_type_id", "Issue type id.", "issue_type.id"),
    C.bool("is_subtask", "Whether the issue type is a sub-task type.", "issue_type.subtask"),
    C.str("status_id", "Status id.", "id", false),
    C.str("status", "Status name.", "name"),
    C.str("status_category", "Status category name (To Do, In Progress, Done).", "statusCategory.name"),
    C.str("status_category_key", "Status category key (new, indeterminate, done).", "statusCategory.key"),
  ],
  rows: (rows) =>
    rows.flatMap((it) => ((it.statuses ?? []) as Row[]).map((s) => ({ ...s, issue_type: it, __ctx: it.__ctx }))),
  examples: [
    {
      description: "Statuses of the Bug workflow in a project",
      sql: "SELECT status, status_category FROM jira.main.project_statuses(project_key := 'ENG') WHERE issue_type = 'Bug' ORDER BY status",
    },
  ],
});

// --------------------------------------------------------------------- agile

const BOARD_COLS: Col[] = [
  C.big("id", "Board id (what sprints(board_id := …) takes).", "id", false),
  C.str("name", "Board name. = pushes down (name=, re-checked exactly).", "name"),
  C.str("type", "scrum, kanban or simple. Pushed down.", "type"),
  C.str("project_key", "Key of the board's project (location). Pushed down (projectKeyOrId).", "location.projectKey"),
  C.str("project_name", "Name of the board's project.", (r) => r.location?.projectName ?? r.location?.displayName),
];

function boardsRequest(scan: ScanContext<Record<string, unknown>>): PageRequest {
  const one = (c: string) => {
    const v = eqValues(scan.constraints, c);
    return v?.length === 1 ? v[0] : undefined;
  };
  return {
    url: withQuery(agile(scan.cfg, "/board"), {
      maxResults: "50",
      type: one("type"),
      name: one("name"),
      projectKeyOrId: one("project_key"),
    }),
    paging: { style: "offset", key: "values" },
  };
}

const boards = defineCatalogTable(
  {
    name: "boards",
    product: "jira",
    description: "Jira Software boards (scrum, kanban).",
    title: "Agile Boards",
    category: "agile",
    keywords: "jira, boards, scrum, kanban, agile",
    docLlm:
      "boards lists Jira Software boards: id (pass to sprints(board_id := …)), name, type (scrum / " +
      "kanban / simple), project_key, project_name. WHERE type = …, name = … and project_key = … are " +
      "sent as query parameters to /rest/agile/1.0/board.",
    docMd: "## boards\n\nAgile boards and the project each belongs to.",
    pushdown: "type =, name =, project_key = (agile query parameters).",
    primaryKey: "id",
    columns: BOARD_COLS,
    plan: (scan) => ({ kind: "phases", phases: [boardsRequest(scan as never)] }),
    examples: [
      {
        description: "Scrum boards per project",
        sql: "SELECT project_key, name, id FROM jira.main.boards WHERE type = 'scrum' ORDER BY project_key, name",
      },
    ],
  },
  "main",
);

const sprints: VgiFunction = defineAtlassianTable<{ board_id: bigint | number | null }>({
  name: "sprints",
  product: "jira",
  args: { board_id: int64() },
  argDocs: { board_id: "Board id (named). A WHERE board_id = / IN filter works too; otherwise every board is read." },
  argDefaults: { board_id: null },
  description: "Sprints of Jira Software boards.",
  title: "Sprints",
  category: "agile",
  keywords: "jira, sprints, scrum, iterations, velocity, sprint goal",
  docLlm:
    "sprints(board_id := NULL) lists sprints: board_id, id (matches issues.sprint_ids), name, state " +
    "(active / closed / future), goal, start_at, end_at, complete_at, created_at, origin_board_id. " +
    "WHERE state = / IN is sent as state=. Kanban boards have no sprints and contribute no rows. To " +
    "get a sprint's issues: jira.main.issues() WHERE list_contains(sprint_ids, <id>).",
  docMd: "## sprints(board_id := NULL)\n\nSprints with dates, state and goal.",
  pushdown: "board_id = / IN selects boards; state = / IN → state=.",
  columns: [
    C.big("board_id", "Board the sprint was read from (pushed down).", (r) => r.__ctx?.board_id, false),
    C.big("id", "Sprint id.", "id", false),
    C.str("name", "Sprint name.", "name"),
    C.str("state", "active, closed or future. Pushed down.", "state"),
    C.str("goal", "Sprint goal.", "goal"),
    C.time("start_at", "Planned start.", "startDate"),
    C.time("end_at", "Planned end.", "endDate"),
    C.time("complete_at", "When the sprint was completed.", "completeDate"),
    C.time("created_at", "When the sprint was created.", "createdDate"),
    C.big("origin_board_id", "Board the sprint was created on.", "originBoardId"),
  ],
  plan: (scan) => {
    const arg = scan.args.board_id;
    const ids = arg != null ? [String(arg)] : eqValues(scan.constraints, "board_id");
    const states = eqValues(scan.constraints, "state");
    return {
      kind: "fanout",
      ids,
      parents: [boardsRequest(scan as never)],
      parentId: (r) => (r.id != null ? String(r.id) : null),
      child: (id) => ({
        url: withQuery(agile(scan.cfg, `/board/${enc(id)}/sprint`), { maxResults: "50", state: states?.join(",") }),
        paging: { style: "offset", key: "values" },
        ctx: { board_id: id },
      }),
    };
  },
  // Kanban boards answer 400 ("The board does not support sprints").
  emptyOn: [400, 404],
  examples: [
    {
      description: "The active sprint of each board",
      sql: "SELECT board_id, name, goal, end_at FROM jira.main.sprints() WHERE state = 'active' ORDER BY board_id",
    },
    {
      description: "Done vs total issues of the active sprint of board 1",
      sql: "SELECT count(*) FILTER (WHERE i.state = 'closed') AS done, count(*) AS total FROM jira.main.sprints(board_id := 1) s JOIN jira.main.issues() i ON list_contains(i.sprint_ids, s.id) WHERE s.state = 'active'",
    },
  ],
});

// ------------------------------------------------------------------- site metadata

function listing(
  name: string,
  path: string,
  spec: Omit<TableSpec<Record<string, never>>, "name" | "product" | "plan" | "category"> & {
    paging?: "array" | "users";
  },
) {
  return defineCatalogTable(
    {
      ...spec,
      name,
      product: "jira",
      category: "configuration",
      plan: (scan) => {
        if (spec.paging === "users") {
          const url =
            scan.deployment === "cloud"
              ? withQuery(api(scan.cfg, "cloud", "/users/search"), { maxResults: "100" })
              : withQuery(api(scan.cfg, "datacenter", "/user/search"), { username: ".", maxResults: "100" });
          return { kind: "phases", phases: [{ url, paging: { style: "arrayOffset" } }] };
        }
        return { kind: "phases", phases: [{ url: api(scan.cfg, scan.deployment, path), paging: { style: "array" } }] };
      },
    },
    "main",
  );
}

const users = listing("users", "/users/search", {
  paging: "users",
  description: "Jira users (people, apps and customers) visible to the secret's user.",
  title: "Jira Users",
  keywords: "jira, users, people, accounts, account ids, directory",
  docLlm:
    "users lists Jira users: account_id (Cloud accountId; Data Center user key), name (Data Center " +
    "username; NULL on Cloud), display_name, email_address (NULL unless the user's privacy settings " +
    "make it visible), active, account_type (atlassian / app / customer), time_zone, locale. Join " +
    "issues.assignee / user_login to account_id on Cloud and to name on Data Center.",
  docMd: "## users\n\nUsers and their account ids. Emails appear only where Atlassian exposes them.",
  primaryKey: "account_id",
  columns: [
    C.str("account_id", "accountId (Cloud) or user key (Data Center).", (r) => r.accountId ?? r.key, false),
    C.str("name", "Username (Data Center); NULL on Cloud.", "name"),
    C.str("display_name", "Name shown in the Jira UI (full name for people).", "displayName"),
    C.str("email_address", "Email address; NULL unless visible under the user's privacy settings.", "emailAddress"),
    C.bool("active", "Whether the account is active.", "active"),
    C.str("account_type", "atlassian (person), app or customer (Cloud).", "accountType"),
    C.str("time_zone", "IANA time zone from the user profile (e.g. Europe/London).", "timeZone"),
    C.str("locale", "Language/region from the user profile (e.g. en_GB).", "locale"),
  ],
  examples: [
    {
      description: "Active human accounts",
      sql: "SELECT display_name, account_id FROM jira.main.users WHERE active AND coalesce(account_type, 'atlassian') = 'atlassian' ORDER BY display_name",
    },
  ],
});

const fields = listing("fields", "/field", {
  description: "Jira fields, system and custom, with their JQL clause names and types.",
  title: "Jira Fields",
  keywords: "jira, fields, custom fields, story points, schema, jql clause names",
  docLlm:
    "fields lists every Jira field: id (e.g. summary, customfield_10016), key, name, is_custom, " +
    "schema_type (string / number / array / option / user / date …), schema_items, schema_custom (the " +
    "custom field type key), custom_id, clause_names (names usable in JQL, e.g. cf[10016]), searchable, " +
    "orderable, navigable. Use it to find a custom field to hoist with the custom_fields ATTACH option " +
    "or to read from issues.custom_fields.",
  docMd: "## fields\n\nThe field catalogue: find custom field ids, types and JQL names.",
  primaryKey: "id",
  columns: [
    C.str("id", "Field id.", "id", false),
    C.str("key", "Field key.", "key"),
    C.str("name", "Field name.", "name"),
    C.bool("is_custom", "Whether this is a custom field.", "custom"),
    C.str("schema_type", "Value type: string, number, array, option, user, date, datetime …", "schema.type"),
    C.str("schema_items", "Element type of array fields.", "schema.items"),
    C.str("schema_custom", "Custom field type key (e.g. com.pyxis.greenhopper.jira:gh-sprint).", "schema.custom"),
    C.big("custom_id", "Numeric custom field id (cf[N] in JQL).", "schema.customId"),
    C.strList("clause_names", "Names usable in JQL.", "clauseNames"),
    C.bool("searchable", "Whether the field can be searched in JQL.", "searchable"),
    C.bool("orderable", "Whether JQL can ORDER BY it.", "orderable"),
    C.bool("navigable", "Whether it appears in issue navigator columns.", "navigable"),
  ],
  examples: [
    {
      description: "Custom fields and their types",
      sql: "SELECT name, id, schema_type FROM jira.main.fields WHERE is_custom ORDER BY name",
    },
  ],
});

const statuses = listing("statuses", "/status", {
  description: "Jira workflow statuses and their categories.",
  title: "Workflow Statuses",
  keywords: "jira, statuses, workflow, status categories, done",
  docLlm:
    "statuses lists every workflow status: id, name, description, status_category (To Do / In " +
    "Progress / Done), status_category_key (new / indeterminate / done), scope_type (PROJECT for " +
    "team-managed statuses), scope_project_id.",
  docMd: "## statuses\n\nWorkflow statuses and their categories.",
  primaryKey: "id",
  columns: [
    C.str("id", "Status id.", "id", false),
    C.str("name", "Status name.", "name"),
    C.str("description", "Status description.", "description"),
    C.str("status_category", "Category name: To Do, In Progress, Done.", "statusCategory.name"),
    C.str("status_category_key", "Category key: new, indeterminate, done.", "statusCategory.key"),
    C.str("scope_type", "PROJECT for team-managed project statuses; NULL when global.", "scope.type"),
    C.str("scope_project_id", "Project of a team-managed status.", "scope.project.id"),
  ],
  examples: [
    {
      description: "Statuses that count as done",
      sql: "SELECT name FROM jira.main.statuses WHERE status_category_key = 'done' ORDER BY name",
    },
  ],
});

const priorities = listing("priorities", "/priority", {
  description: "Jira issue priorities (Highest … Lowest) with their colours and icons.",
  title: "Issue Priorities",
  keywords: "jira, priorities, severity, urgency",
  docLlm: "priorities lists issue priorities: id, name, description, status_color (hex), icon_url.",
  docMd: "## priorities\n\nIssue priorities.",
  primaryKey: "id",
  columns: [
    C.str("id", "Priority id.", "id", false),
    C.str("name", "Priority name.", "name"),
    C.str("description", "Priority description.", "description"),
    C.str("status_color", "Display colour (hex).", "statusColor"),
    C.str("icon_url", "URL of the priority's icon image.", "iconUrl"),
  ],
  examples: [{ description: "All priorities", sql: "SELECT id, name FROM jira.main.priorities ORDER BY id" }],
});

const issueTypes = listing("issue_types", "/issuetype", {
  description: "Jira issue types (Epic, Story, Bug, Task, Sub-task …) and their hierarchy levels.",
  title: "Jira Issue Types",
  keywords: "jira, issue types, bug, story, epic, task, sub-task, hierarchy",
  docLlm:
    "issue_types lists issue types: id, name, description, is_subtask, hierarchy_level (Cloud: 1 epic, " +
    "0 standard, -1 sub-task), scope_project_id (team-managed project types).",
  docMd: "## issue_types\n\nIssue types and their hierarchy level.",
  primaryKey: "id",
  columns: [
    C.str("id", "Issue type id.", "id", false),
    C.str("name", "Issue type name.", "name"),
    C.str("description", "Issue type description.", "description"),
    C.bool("is_subtask", "Whether it is a sub-task type.", "subtask"),
    C.big("hierarchy_level", "Hierarchy level (Cloud): 1 epic, 0 standard, -1 sub-task.", "hierarchyLevel"),
    C.str("scope_project_id", "Project of a team-managed issue type.", "scope.project.id"),
  ],
  examples: [
    {
      description: "Sub-task issue types",
      sql: "SELECT name FROM jira.main.issue_types WHERE is_subtask ORDER BY name",
    },
  ],
});

export const JIRA_FUNCTIONS: VgiFunction[] = [
  changelog,
  comments,
  worklogs,
  links,
  components,
  versions,
  projectStatuses,
  sprints,
];
export const JIRA_TABLES = [projects, boards, users, fields, statuses, priorities, issueTypes];
