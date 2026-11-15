/**
 * Confluence Cloud: spaces (REST v2), pages and blog posts via CQL search (REST v1
 * `/wiki/rest/api/search`), and per-page versions, labels and comments (REST v2).
 */

import { utf8, type VgiFunction } from "@query-farm/vgi";
import { andJoin, buildClauses, eqValues, type FieldMap } from "../atlassian/pushdown.ts";
import {
  C,
  defineAtlassianTable,
  defineCatalogTable,
  type PageRequest,
  type Plan,
  type Row,
  type ScanContext,
  withQuery,
} from "../atlassian/table.ts";
import { storageToText } from "../atlassian/text.ts";

const enc = encodeURIComponent;
const wiki = (scan: ScanContext<unknown>, path: string) => `${scan.cfg.confluenceBase}/wiki${path}`;
const webui = (scan: ScanContext<unknown>) => `${scan.cfg.siteUrl}/wiki`;

// ------------------------------------------------------------------------ spaces

const spaces = defineCatalogTable(
  {
    name: "spaces",
    product: "confluence",
    description: "Confluence spaces: key, name, type, status and home page of every space you can see.",
    title: "Confluence Spaces",
    category: "spaces",
    keywords: "confluence, spaces, space keys, wiki, personal spaces",
    docLlm:
      "spaces lists Confluence spaces (REST v2 /wiki/api/v2/spaces): id, key, name, type (global / " +
      "personal / collaboration / knowledge_base), status (current / archived), author_id, created_at, " +
      "homepage_id, html_url. WHERE key = / IN, type = and status = are sent as query parameters.",
    docMd: "## spaces\n\nConfluence spaces with type, status and home page.",
    pushdown: "key = / IN (keys=), type =, status =.",
    primaryKey: "id",
    columns: [
      C.str("id", "Space id.", "id", false),
      C.str("key", "Space key (ENG). Pushed down.", "key"),
      C.str("name", "Space name.", "name"),
      C.str("type", "global, personal, collaboration or knowledge_base. Pushed down.", "type"),
      C.str("status", "current or archived. Pushed down.", "status"),
      C.str("author_id", "accountId of the space creator.", "authorId"),
      C.time("created_at", "When the space was created.", "createdAt"),
      C.str("homepage_id", "Id of the space home page.", "homepageId"),
      C.str("html_url", "Link to the space in the Confluence UI.", (r) =>
        r._links?.webui ? `${r.__ctx?.webui ?? ""}${r._links.webui}` : null,
      ),
    ],
    plan: (scan) => {
      const one = (c: string) => {
        const v = eqValues(scan.constraints, c);
        return v?.length === 1 ? v[0] : undefined;
      };
      return {
        kind: "phases",
        phases: [
          {
            url: withQuery(wiki(scan, "/api/v2/spaces"), {
              limit: "100",
              keys: eqValues(scan.constraints, "key")?.join(","),
              type: one("type"),
              status: one("status"),
            }),
            paging: { style: "links" },
            ctx: { webui: webui(scan) },
          },
        ],
      };
    },
    examples: [
      {
        description: "Global spaces",
        sql: "SELECT key, name FROM jira.confluence.spaces WHERE type = 'global' ORDER BY key",
      },
    ],
  },
  "confluence",
);

// ------------------------------------------------------------------------- pages

const PAGE_FIELDS: Record<string, FieldMap> = {
  id: { field: "id", kind: "number" },
  space_key: { field: "space", kind: "string", ne: true },
  type: { field: "type", kind: "string", ne: true },
  title: { field: "title", kind: "string" },
  labels: { field: "label", kind: "list" },
  created_at: { field: "created", kind: "time" },
  last_modified_at: { field: "lastmodified", kind: "time" },
  author_id: { field: "creator", kind: "string" },
  parent_id: { field: "parent", kind: "number" },
};

/** `content.*` expansions the selected columns need. */
const EXPANDS: Record<string, string[]> = {
  space_key: ["content.space"],
  space_name: ["content.space"],
  author_id: ["content.history"],
  author_display_name: ["content.history"],
  created_at: ["content.history"],
  version: ["content.version"],
  last_modified_by: ["content.version"],
  labels: ["content.metadata.labels"],
  parent_id: ["content.ancestors"],
  body_storage: ["content.body.storage"],
  body_text: ["content.body.storage"],
};

const pages: VgiFunction = defineAtlassianTable<{ cql: string | null }>({
  name: "pages",
  product: "confluence",
  args: { cql: utf8() },
  argDocs: { cql: "Optional CQL (named), ANDed with the clauses generated from WHERE; its ORDER BY is kept." },
  argDefaults: { cql: null },
  description: "Confluence pages and blog posts from a CQL search, with storage-format and plain-text bodies.",
  title: "Pages",
  category: "content",
  keywords: "confluence, pages, blog posts, cql, wiki, documentation, search, knowledge base",
  docLlm:
    "pages(cql := NULL) searches Confluence content with CQL (/wiki/rest/api/search) and returns one row " +
    "per page or blog post: id, type (page / blogpost), status, title, space_key, space_name, " +
    "parent_id, author_id, author_display_name, created_at, version, last_modified_at, " +
    "last_modified_by, labels, excerpt, body_storage (storage-format XHTML), body_text (plain text " +
    "extracted from it), html_url. Without a type filter both pages and blog posts are returned. WHERE " +
    "filters on space_key, type, title (= exact), labels (list_contains), id, parent_id, author_id, " +
    "created_at and last_modified_at ranges become CQL (ANDed with cql). Use cql := 'text ~ \"…\"' or " +
    "'title ~ \"…\"' for full-text search. Bodies are fetched only when selected.",
  docMd:
    "## pages(cql := NULL)\n\nPages and blog posts from a CQL search. The `body_text` column holds " +
    "plain text and `body_storage` the raw storage XHTML; both are fetched only when a query reads them.",
  pushdown:
    "space_key, type (= / IN / !=), title =, id, parent_id, author_id, list_contains(labels, …), " +
    "created_at / last_modified_at ranges (widened a day, re-checked exactly) → CQL ANDed with cql.",
  columns: [
    C.str("id", "Content id. Pushed down.", "content.id", false),
    C.str("type", "page or blogpost. Pushed down.", "content.type"),
    C.str("status", "current, draft, archived …", "content.status"),
    C.str("title", 'Title. = pushes down (title = "…").', (r) => r.content?.title ?? r.title),
    C.str("space_key", "Space key. Pushed down.", "content.space.key"),
    C.str("space_name", "Space name.", "content.space.name"),
    C.str("parent_id", "Direct parent page id (last ancestor). Pushed down (parent =).", (r) => {
      const a = r.content?.ancestors;
      return Array.isArray(a) && a.length ? a[a.length - 1]?.id : null;
    }),
    C.str("author_id", "Creator accountId. Pushed down (creator =).", "content.history.createdBy.accountId"),
    C.str("author_display_name", "Creator display name.", "content.history.createdBy.displayName"),
    C.time("created_at", "When the content was created. Ranges push down.", "content.history.createdDate"),
    C.big("version", "Current version number.", "content.version.number"),
    C.time("last_modified_at", "When the content last changed. Ranges push down (lastmodified).", "lastModified"),
    C.str("last_modified_by", "accountId of the last editor.", "content.version.by.accountId"),
    C.strList("labels", "Labels. list_contains(labels, 'x') pushes down (label = \"x\").", (r) => {
      const l = r.content?.metadata?.labels?.results;
      return Array.isArray(l) ? l.map((x: Row) => x.name) : null;
    }),
    C.str("excerpt", "Search excerpt.", "excerpt"),
    C.str(
      "body_storage",
      "Body in storage format (XHTML with ac:/ri: macros). Fetched only when selected.",
      "content.body.storage.value",
    ),
    C.str("body_text", "Body as plain text (extracted from storage format). Fetched only when selected.", (r) =>
      storageToText(r.content?.body?.storage?.value),
    ),
    C.str("html_url", "Link to the page in the Confluence UI.", (r) =>
      r.content?._links?.webui ? `${r.__ctx?.webui ?? ""}${r.content._links.webui}` : null,
    ),
  ],
  plan: (scan): Plan => {
    const parts = buildClauses(scan.constraints, PAGE_FIELDS);
    const hasType = scan.constraints.some((c) => c.column === "type");
    if (!hasType && !/\btype\s*(=|!=|in|not\s+in)/i.test(scan.args.cql ?? ""))
      parts.unshift("type in (page, blogpost)");
    const cql = andJoin(scan.args.cql, parts, "ORDER BY id ASC");
    const expand = new Set<string>();
    for (const c of scan.needed) for (const e of EXPANDS[c] ?? []) expand.add(e);
    const req: PageRequest = {
      url: withQuery(wiki(scan, "/rest/api/search"), { cql, limit: "50", expand: [...expand].sort().join(",") }),
      paging: { style: "links" },
      ctx: { webui: webui(scan) },
    };
    return { kind: "phases", phases: [req] };
  },
  examples: [
    {
      description: "Runbooks in a space (space and label become CQL)",
      sql: "SELECT title, last_modified_at FROM jira.confluence.pages() WHERE space_key = 'OPS' AND list_contains(labels, 'runbook') ORDER BY title",
    },
    {
      description: "Full-text search, reading plain-text bodies",
      sql: "SELECT title, left(body_text, 200) AS preview FROM jira.confluence.pages(cql := 'text ~ \"deploy\"') WHERE type = 'page' ORDER BY title",
    },
  ],
});

// --------------------------------------------------------------- per-page children

interface PageArgs extends Record<string, unknown> {
  page_id: string | null;
}

function perPage(scan: ScanContext<PageArgs>, child: (id: string) => PageRequest): Plan {
  const arg = scan.args.page_id;
  const ids = typeof arg === "string" && arg ? [arg] : eqValues(scan.constraints, "page_id");
  if (ids) return { kind: "fanout", ids, parents: [], parentId: () => null, child };
  // No page given: walk every page (CQL search), then each one's children.
  return {
    kind: "fanout",
    parents: [
      {
        url: withQuery(wiki(scan, "/rest/api/search"), { cql: "type = page ORDER BY id ASC", limit: "50" }),
        paging: { style: "links" },
      },
    ],
    parentId: (r) => (r.content?.id ? String(r.content.id) : null),
    child,
  };
}

const PAGE_ARGS = {
  args: { page_id: utf8() },
  argDocs: { page_id: "Page id (named). A WHERE page_id = / IN filter works too; otherwise every page is read." },
  argDefaults: { page_id: null },
};
const PAGE_ID_COL = C.ctx("page_id", "Page id (pushed down: = / IN).", "page_id");

const pageVersions: VgiFunction = defineAtlassianTable<PageArgs>({
  name: "page_versions",
  product: "confluence",
  ...PAGE_ARGS,
  description: "Version history of Confluence pages.",
  title: "Page Versions",
  category: "content",
  keywords: "confluence, versions, history, edits, page history",
  docLlm:
    "page_versions(page_id := NULL) lists every version of a page (/wiki/api/v2/pages/{id}/versions): " +
    "page_id, number, message, minor_edit, author_id, created_at.",
  docMd: "## page_versions(page_id := NULL)\n\nWho edited a page, when, and with what message.",
  pushdown: "page_id = / IN reads only those pages.",
  columns: [
    PAGE_ID_COL,
    C.big("number", "Version number.", "number", false),
    C.str("message", "Version message.", "message"),
    C.bool("minor_edit", "Whether this was a minor edit.", "minorEdit"),
    C.str("author_id", "accountId of the editor.", "authorId"),
    C.time("created_at", "When the version was created.", "createdAt"),
  ],
  plan: (scan) =>
    perPage(scan, (id) => ({
      url: withQuery(wiki(scan, `/api/v2/pages/${enc(id)}/versions`), { limit: "50" }),
      paging: { style: "links" },
      ctx: { page_id: id },
    })),
  emptyOn: [404],
  examples: [
    {
      description: "Edit history of a page",
      sql: "SELECT number, author_id, created_at, message FROM jira.confluence.page_versions(page_id := '1001') ORDER BY number",
    },
  ],
});

const pageLabels: VgiFunction = defineAtlassianTable<PageArgs>({
  name: "page_labels",
  product: "confluence",
  ...PAGE_ARGS,
  description: "Labels on Confluence pages.",
  title: "Page Labels",
  category: "content",
  keywords: "confluence, labels, tags, taxonomy",
  docLlm:
    "page_labels(page_id := NULL) lists the labels of pages (/wiki/api/v2/pages/{id}/labels): page_id, " +
    "id, name, prefix (global / my / team). For filtering pages by label prefer " +
    "pages() WHERE list_contains(labels, '…').",
  docMd: "## page_labels(page_id := NULL)\n\nPage labels with their prefix.",
  pushdown: "page_id = / IN reads only those pages.",
  columns: [
    PAGE_ID_COL,
    C.str("id", "Label id.", "id", false),
    C.str("name", "Label name.", "name"),
    C.str("prefix", "Label prefix: global, my or team.", "prefix"),
  ],
  plan: (scan) =>
    perPage(scan, (id) => ({
      url: withQuery(wiki(scan, `/api/v2/pages/${enc(id)}/labels`), { limit: "100" }),
      paging: { style: "links" },
      ctx: { page_id: id },
    })),
  emptyOn: [404],
  examples: [
    {
      description: "Most used labels across pages",
      sql: "SELECT name, count(*) AS pages FROM jira.confluence.page_labels() GROUP BY name ORDER BY pages DESC, name",
    },
  ],
});

const pageComments: VgiFunction = defineAtlassianTable<PageArgs>({
  name: "page_comments",
  product: "confluence",
  ...PAGE_ARGS,
  description: "Footer and inline comments on Confluence pages.",
  title: "Page Comments",
  category: "content",
  keywords: "confluence, comments, inline comments, feedback, review",
  docLlm:
    "page_comments(page_id := NULL) lists footer and inline comments of pages (REST v2): page_id, id, " +
    "kind ('footer' / 'inline'), status, author_id, created_at, version, body_storage, body_text, " +
    "resolution_status (inline: open / resolved / dangling), inline_selection (the highlighted text).",
  docMd: "## page_comments(page_id := NULL)\n\nFooter and inline comments with plain-text bodies.",
  pushdown: "page_id = / IN reads only those pages.",
  columns: [
    PAGE_ID_COL,
    C.str("id", "Comment id.", "id", false),
    C.str("kind", "footer or inline.", (r) => r.__ctx?.kind),
    C.str("status", "Comment status (current …).", "status"),
    C.str("author_id", "accountId of the author.", "version.authorId"),
    C.time("created_at", "When the comment (its current version) was created.", "version.createdAt"),
    C.big("version", "Comment version number.", "version.number"),
    C.str("body_storage", "Body in storage format.", "body.storage.value"),
    C.str("body_text", "Body as plain text.", (r) => storageToText(r.body?.storage?.value)),
    C.str("resolution_status", "Inline comments: open, reopened, resolved or dangling.", "resolutionStatus"),
    C.str("inline_selection", "Inline comments: the highlighted page text.", "properties.inlineOriginalSelection"),
  ],
  plan: (scan) => {
    const p = perPage(scan, (id) => ({
      url: withQuery(wiki(scan, `/api/v2/pages/${enc(id)}/footer-comments`), {
        limit: "100",
        "body-format": "storage",
      }),
      paging: { style: "links" },
      ctx: { page_id: id, kind: "footer" },
    }));
    // Footer and inline comments are two endpoints: queue each page twice ("<id>\tinline").
    if (p.kind !== "fanout") return p;
    const child = (raw: string): PageRequest => {
      const [id, kind] = raw.split("\t") as [string, string | undefined];
      const k = kind ?? "footer";
      return {
        url: withQuery(wiki(scan, `/api/v2/pages/${enc(id)}/${k}-comments`), {
          limit: "100",
          "body-format": "storage",
        }),
        paging: { style: "links" },
        ctx: { page_id: id, kind: k },
      };
    };
    const twice = (id: string) => [`${id}\tfooter`, `${id}\tinline`];
    return {
      kind: "fanout",
      ids: p.ids?.flatMap(twice),
      parents: p.parents.map((pp) => ({ ...pp })),
      parentId: p.parentId,
      expand: twice,
      child,
    };
  },
  emptyOn: [404],
  examples: [
    {
      description: "Unresolved inline comments on a page",
      sql: "SELECT author_id, inline_selection, body_text FROM jira.confluence.page_comments(page_id := '1001') WHERE kind = 'inline' AND resolution_status = 'open' ORDER BY created_at",
    },
  ],
});

export const CONFLUENCE_FUNCTIONS: VgiFunction[] = [pages, pageVersions, pageLabels, pageComments];
export const CONFLUENCE_TABLES = [spaces];
