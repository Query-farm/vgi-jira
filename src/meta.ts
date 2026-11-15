/**
 * Discovery metadata: catalog/schema docs, categories and helpers.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these tags.
 * Every function carries `objectTags(...)`: a title, a category from its schema's
 * category list, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "jira";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-jira";

/** Categories of the `main` (Jira) schema. */
export const JIRA_CATEGORIES = [
  {
    name: "issues",
    title: "Issues",
    description: "Jira issues (JQL search), their changelog, comments, worklogs and links.",
  },
  {
    name: "projects",
    title: "Projects",
    description: "Jira projects with their components, versions and per-issue-type workflow statuses.",
  },
  { name: "agile", title: "Agile", description: "Jira Software boards and sprints (Agile REST API)." },
  {
    name: "configuration",
    title: "Configuration",
    description: "Site-wide Jira metadata: fields (custom fields too), statuses, priorities, issue types, users.",
  },
] as const;

/** Categories of the `confluence` schema. */
export const CONFLUENCE_CATEGORIES = [
  { name: "spaces", title: "Spaces", description: "Confluence spaces." },
  {
    name: "content",
    title: "Content",
    description: "Confluence pages and blog posts (CQL search) with bodies, versions, labels and comments.",
  },
] as const;

export type Category = (typeof JIRA_CATEGORIES)[number]["name"] | (typeof CONFLUENCE_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [Jira Cloud REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/) and the [enhanced JQL search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-get)\n" +
  "- [Jira Data Center REST API v2](https://developer.atlassian.com/server/jira/platform/rest/v10000/intro/)\n" +
  "- [JQL reference](https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/)\n" +
  "- [Jira Software (Agile) REST API](https://developer.atlassian.com/cloud/jira/software/rest/intro/)\n" +
  "- [Confluence Cloud REST API v2](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/) and [CQL](https://developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/)\n" +
  "- [Rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/) and [API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)";

export const CATALOG_COMMENT =
  "Atlassian Jira (Cloud and Data Center) and Confluence Cloud as SQL: issues, changelogs, sprints, projects, pages and spaces, read-only, with JQL and CQL pushdown.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to Atlassian Jira (Cloud REST v3 or Data Center REST v2, detected automatically) " +
  "and Confluence Cloud. Schema `main` is Jira: issues(jql := …) runs a JQL search, and WHERE filters on " +
  "project/repo, key, id, status, status_category, state, issue_type, is_subtask, priority, resolution, " +
  "assignee, user_login (reporter), labels/components/fix_versions/sprint_ids (list_contains), " +
  "parent_key and created_at/updated_at/closed_at ranges are translated into JQL and ANDed with the " +
  "jql argument; only the projected columns are requested via the fields parameter. Issue columns " +
  "align with the GitHub and GitLab workers (repo, number, title, state 'open'/'closed', user_login, " +
  "assignees, labels, body, html_url, created_at, updated_at, closed_at) so issues UNION across " +
  "trackers. Custom fields come back as a JSON map keyed by field name (custom_fields) and can be " +
  "hoisted into typed columns with the ATTACH option custom_fields 'col=Field Name:TYPE, …'. " +
  "issue_changelog gives field-level history (WHERE field = 'status' for transitions and cycle " +
  "time); issue_comments, issue_worklogs and issue_links take issue_key = / IN or a jql argument. " +
  "Also projects, components, versions, project_statuses, boards, sprints, users, fields, statuses, " +
  "priorities and issue_types. Schema `confluence` covers spaces, pages(cql := …) with CQL pushdown " +
  "(space_key, type, labels, title, created_at, last_modified_at), page bodies as storage XHTML " +
  "and plain text, page_versions, page_labels and page_comments. Every object needs an `atlassian` " +
  "secret: SITE_URL plus EMAIL + API_TOKEN (Cloud), PERSONAL_ACCESS_TOKEN (Data Center) or " +
  "OAUTH_ACCESS_TOKEN (+ CLOUD_ID). 429 Retry-After / X-RateLimit headers are honoured. Docs: " +
  "https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/ ; " +
  "https://developer.atlassian.com/cloud/confluence/rest/v2/intro/ .";

export const CATALOG_DOC_MD =
  "# Jira and Confluence\n\n" +
  "Query Atlassian Jira (Cloud or Data Center) and Confluence Cloud from DuckDB: issues with their " +
  "changelog, comments, worklogs and links; projects, boards and sprints; site configuration; and " +
  "Confluence spaces and pages. Read-only.\n\n" +
  "Create an `atlassian` secret with your site URL and an API token (Cloud), a personal access " +
  "token (Data Center) or an OAuth access token. WHERE filters become JQL or CQL and only the " +
  "columns you select are fetched, so filter and project early.\n\n" +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "Jira as SQL. issues(jql := NULL, page_size := 100) is the main entry point: WHERE filters push " +
  "into JQL (ANDed with jql), projection picks the fields= list. Per-issue collections " +
  "(issue_changelog, issue_comments, issue_worklogs, issue_links) take issue_key = / IN or jql := and " +
  "otherwise read every issue the JQL matches. Per-project collections (components, versions, " +
  "project_statuses) take project_key; sprints take board_id; otherwise they fan out over every " +
  "project / board. projects, boards, users, fields, statuses, priorities and issue_types are " +
  "plain listings. Users are identified by accountId on Cloud and by username on Data Center.";

export const SCHEMA_DOC_MD =
  "## main (Jira)\n\n" +
  "Issues from JQL search with SQL→JQL pushdown, per-issue history, comments, worklogs and links, " +
  "projects and their components/versions/statuses, boards and sprints, and site metadata.\n\n" +
  "All objects need an `atlassian` secret.";

export const CONFLUENCE_DOC_LLM =
  "Confluence Cloud as SQL. spaces lists spaces (v2 API). pages(cql := NULL) searches pages and blog " +
  "posts with CQL (v1 search): WHERE space_key / type / title / labels (list_contains) / created_at / " +
  "last_modified_at / id push into CQL, ANDed with cql; the storage body and plain-text body are " +
  "fetched only when selected. page_versions, page_labels and page_comments take page_id (named " +
  "argument or = / IN filter).";

export const CONFLUENCE_DOC_MD =
  "## confluence\n\n" +
  "Confluence Cloud spaces and content: CQL search over pages and blog posts with bodies as storage " +
  "XHTML and plain text, version history, labels and comments.\n\n" +
  "WHERE filters on space, type, title, labels and dates become CQL. Per-page collections take a " +
  "page id.\n\nAll objects need an `atlassian` secret for a Confluence Cloud site.";

export const AGENT_TEST_TASKS = [
  { name: "open_bugs_eng", prompt: "List the keys and titles of open bugs in the ENG Jira project." },
  { name: "issues_per_status", prompt: "How many Jira issues are there in each status category?" },
  { name: "ada_assigned", prompt: "Which issues are assigned to Ada Lovelace, and what is their status?" },
  {
    name: "status_transitions",
    prompt: "Show every status transition of issue ENG-1 in order, with who made it and when.",
  },
  { name: "active_sprint", prompt: "What is the name of the active sprint on the ENG scrum board?" },
  { name: "sprint_issues", prompt: "Which issues are in the active sprint, and how many are done?" },
  { name: "label_count", prompt: "How many Jira issues carry the 'backend' label?" },
  { name: "eng_components", prompt: "What components does the ENG project have, and who leads each one?" },
  { name: "time_logged", prompt: "How many hours of work have been logged on ENG-2 in total?" },
  { name: "custom_fields", prompt: "Which Jira custom fields exist on this site, and what are their types?" },
  { name: "confluence_spaces", prompt: "List the Confluence spaces by key and name." },
  {
    name: "runbook_pages",
    prompt: "Which Confluence pages in the OPS space are labelled 'runbook'? Give their titles.",
  },
  { name: "restricted_comments", prompt: "Which Jira comments are restricted to a role, and on which issues?" },
  { name: "blockers", prompt: "Which Jira issues block other issues, and which issues do they block?" },
  { name: "subtask_types", prompt: "Which Jira issue types are sub-task types?" },
  { name: "highest_priority", prompt: "What is the name of the highest Jira priority?" },
  { name: "bug_workflow", prompt: "Which statuses does the Bug workflow in the ENG project use?" },
  { name: "project_leads", prompt: "Who leads each Jira project?" },
  { name: "done_statuses", prompt: "Which Jira statuses count as done?" },
  { name: "inactive_users", prompt: "Which Jira user accounts are inactive?" },
  { name: "unreleased_versions", prompt: "Which ENG versions are not yet released, and when are they due?" },
  {
    name: "page_editors",
    prompt: "Who edited the Confluence page 'Search architecture' (id 1001), version by version?",
  },
  { name: "page_tags", prompt: "What labels does Confluence page 1012 have?" },
  {
    name: "open_inline_comments",
    prompt: "List the unresolved inline comments on Confluence page 1001 with the text they highlight.",
  },
];

/** Bind-only probes: each binds the function and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "issues_columns",
    description: "The issues() result columns (binds only; create an atlassian secret and drop LIMIT 0 for rows)",
    sql: "SELECT key, title, state, status, assignee, created_at FROM jira.main.issues() LIMIT 0",
  },
  {
    name: "pages_columns",
    description: "The pages() result columns (binds only; create an atlassian secret and drop LIMIT 0 for rows)",
    sql: "SELECT id, space_key, title, last_modified_at FROM jira.confluence.pages() LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Jira and Confluence",
  "vgi.subtitle": "Atlassian Jira issues, sprints and projects plus Confluence pages as SQL, with JQL/CQL pushdown.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "jira, confluence, atlassian, jql, cql, issues, tickets, sprints, agile, scrum, kanban, changelog, cycle time, worklogs, wiki, pages, project management",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Jira",
  domain: "project management",
  "vgi.keywords": keywordsArray("jira, jql, issues, changelog, sprints, boards, projects, worklogs, users"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(JIRA_CATEGORIES),
};

export const CONFLUENCE_SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Confluence Cloud",
  domain: "knowledge management",
  "vgi.keywords": keywordsArray("confluence, cql, pages, spaces, wiki, documentation, labels, comments"),
  "vgi.doc_llm": CONFLUENCE_DOC_LLM,
  "vgi.doc_md": CONFLUENCE_DOC_MD,
  "vgi.categories": JSON.stringify(CONFLUENCE_CATEGORIES),
};
