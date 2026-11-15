<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Jira Issues, Sprints and Confluence Pages in DuckDB

> **vgi-jira** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-jira/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-jira/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

Atlassian Jira (Cloud **and** Data Center) and Confluence Cloud as SQL, read-only. Your
`WHERE` clauses become JQL and CQL, and only the columns you select are fetched. Use it
for issue analytics, cycle time from the changelog, sprint reporting, worklog totals and
documentation audits.

```sql
CREATE SECRET jira (TYPE atlassian, SITE_URL 'https://acme.atlassian.net',
                    EMAIL 'you@acme.com', API_TOKEN '…');

-- Open bugs in ENG by priority: one JQL request
--   project = "ENG" AND issuetype = "Bug" AND statusCategory != Done
SELECT key, title, priority, assignee_display_name
FROM jira.main.issues()
WHERE project_key = 'ENG' AND issue_type = 'Bug' AND state = 'open'
ORDER BY priority, key;

-- Hours each ENG issue spent In Progress, from the status changelog.
SELECT issue_key, sum(epoch(next_at - changed_at)) / 3600 AS hours_in_progress
FROM (SELECT issue_key, changed_at, to_string,
             lead(changed_at) OVER (PARTITION BY issue_key ORDER BY changed_at) AS next_at
      FROM jira.main.issue_changelog(jql := 'project = ENG') WHERE field = 'status')
WHERE to_string = 'In Progress' AND next_at IS NOT NULL
GROUP BY issue_key;

-- Runbooks in the OPS Confluence space, as plain text (CQL: space = "OPS" AND label = "runbook").
SELECT title, body_text FROM jira.confluence.pages()
WHERE space_key = 'OPS' AND list_contains(labels, 'runbook');
```

## Functions and tables

Schema `main` is Jira; schema `confluence` is Confluence Cloud.

| Object | What it returns |
|---|---|
| `issues(jql := NULL, page_size := 100)` | Issues from a JQL search; WHERE → JQL, projection → `fields=` |
| `issue_changelog(issue_key := NULL, jql := NULL)` | One row per changed field: status transitions, reassignments, sprint moves |
| `issue_comments(issue_key := NULL, jql := NULL)` | Comments, body as plain text and raw ADF JSON |
| `issue_worklogs(issue_key := NULL, jql := NULL)` | Time logged |
| `issue_links(jql := NULL)` | Blocks / relates / duplicates, one row per link end |
| `projects` | Projects with type, style, category, lead |
| `components(project_key := NULL)` / `versions(…)` / `project_statuses(…)` | Per-project components, releases, workflow statuses per issue type |
| `boards` / `sprints(board_id := NULL)` | Jira Software boards and sprints (Agile API) |
| `users` | Users (emails only where the profile makes them visible) |
| `fields`, `statuses`, `priorities`, `issue_types` | Site metadata, including custom fields and their JQL names |
| `confluence.spaces` | Confluence spaces (REST v2) |
| `confluence.pages(cql := NULL)` | Pages and blog posts from a CQL search; body as storage XHTML and plain text |
| `confluence.page_versions` / `page_labels` / `page_comments(page_id := NULL)` | Version history, labels, footer + inline comments |

### Columns that UNION with GitHub and GitLab

`issues` uses the same names as the `vgi-github` / `vgi-gitlab` issues tables where the
concepts match: `repo` (project key), `number` (key digits), `title`, `state`
(`'open'`/`'closed'` from the status category), `user_login` (reporter), `assignees`,
`labels`, `body` (plain text), `html_url`, `created_at`, `updated_at`, `closed_at`
(resolution date). Jira-specific columns follow: `key`, `status`, `status_category`,
`issue_type`, `priority`, `resolution`, `assignee`, `components`, `fix_versions`,
`parent_key`, `sprint_ids`, `sprint_names`, estimates and time spent in seconds,
`description_adf` and `custom_fields`.

### Pushdown

| Function | SQL that becomes part of the upstream query |
|---|---|
| `issues` | `project_key`/`repo` (= / IN / !=), `key`, `id`, `status`, `status_category`, `state`, `issue_type`, `is_subtask`, `priority`, `resolution`, `assignee`, `user_login` (= / IN, `IS NULL` → `is EMPTY`); `list_contains` on `labels`, `components`, `fix_versions`, `affects_versions`, `assignees`, `sprint_ids`; `parent_key` (Cloud); `created_at` / `updated_at` / `closed_at` ranges; hoisted numeric custom fields (`cf[N]`). ANDed with `jql`; its `ORDER BY` is kept. |
| per-issue functions | `issue_key = / IN` (or `issue_key :=`) reads just those issues; `jql :=` selects them otherwise |
| `projects` | `key = / IN` (Cloud `keys=`) |
| `boards` / `sprints` | `type`, `name`, `project_key`; `board_id = / IN`, sprint `state = / IN` |
| `confluence.spaces` | `key = / IN`, `type`, `status` |
| `confluence.pages` | `space_key`, `type`, `title =`, `id`, `parent_id`, `author_id`, `list_contains(labels, …)`, `created_at` / `last_modified_at` ranges → CQL, ANDed with `cql` |

Predicates under `OR`/`NOT` are not translated; every pushed predicate is re-checked
exactly by the SDK, so translation only narrows what crosses the network. JQL dates are
minute-precision in the *user's* time zone, so time ranges are widened by a day upstream
and then filtered exactly. All values are double-quoted with backslash escapes.

### Custom fields

`custom_fields` is a JSON object of every non-empty custom field, keyed by field name
(`custom_fields->>'$."Story point estimate"'`). To get typed columns, hoist them at
ATTACH time:

```sql
ATTACH 'jira' (TYPE vgi, LOCATION '/abs/path/to/vgi-jira/bin/vgi-jira-worker',
               custom_fields 'story_points=Story point estimate:DOUBLE, team=customfield_10030, sprint=Sprint:VARCHAR[]');
SELECT key, story_points, team FROM jira.main.issues() WHERE story_points >= 5;   -- cf[10016] >= 5
```

Each entry is `column=Field name | customfield_N | cf[N]` with an optional type
(`VARCHAR` default, `DOUBLE`, `BIGINT`, `BOOLEAN`, `DATE`, `TIMESTAMPTZ`, `VARCHAR[]`,
`JSON`). Option, user and version values are reduced to their value / display name.
Numeric hoisted fields push down as `cf[N]` comparisons.

## Authentication

One secret type, `atlassian`, covers every product and deployment:

```sql
-- Jira / Confluence Cloud: account email + API token (https://id.atlassian.com/manage-profile/security/api-tokens)
CREATE SECRET (TYPE atlassian, SITE_URL 'https://acme.atlassian.net', EMAIL 'you@acme.com', API_TOKEN '…');

-- Jira Data Center: a personal access token (context path allowed)
CREATE SECRET (TYPE atlassian, SITE_URL 'https://jira.corp.example/jira', PERSONAL_ACCESS_TOKEN '…');

-- OAuth 2.0 (3LO) app: routed through https://api.atlassian.com/ex/jira/<cloud_id>
CREATE SECRET (TYPE atlassian, SITE_URL 'https://acme.atlassian.net', OAUTH_ACCESS_TOKEN '…', CLOUD_ID '…');
```

Cloud vs Data Center is detected from `/rest/api/2/serverInfo` (or forced with
`DEPLOYMENT 'cloud' | 'datacenter'`): Cloud uses REST v3 and the enhanced JQL search
(`/rest/api/3/search/jql`, `nextPageToken`), Data Center REST v2 and the classic
`/search` (`startAt`). On Data Center, `EMAIL` + `API_TOKEN` also work as username +
password. The token fields are redacted in `duckdb_secrets()`, never logged and never put
in scan state. Credentials are only ever sent to the configured site (or the gateway).

## Paging and rate limits

Every cursor — `nextPageToken`, `startAt`, Confluence `_links.next`, and the pending
issue / project / board / page ids of a fan-out — lives in the scan's serializable state,
so a long scan resumes on any worker process over HTTP. 429 and 503 responses honour
`Retry-After` (seconds or a date) and Jira Cloud's `X-RateLimit-Reset`; a response marked
`X-RateLimit-NearLimit: true` pauses the next call. Other 5xx and network errors back off
exponentially with jitter (5 attempts, 30 s request timeout).

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone https://github.com/Query-farm/vgi-jira.git && cd vgi-jira
git checkout v0.1.0            # a release tag
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'jira' (TYPE vgi, LOCATION '/abs/path/to/vgi-jira/bin/vgi-jira-worker');
```

**Haybarn 2.0** (`uvx haybarn-cli`):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'jira' (TYPE vgi, LOCATION '/abs/path/to/vgi-jira/bin/vgi-jira-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship
signed standalone executables (no Bun needed); point `LOCATION` at the downloaded binary.
The same binary serves HTTP with `--http --port 8000` (see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests (JQL quoting, ADF/storage text, paging, backoff)
make test-sql                  # test/sql/jira.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real Atlassian site. `test/mock_api/server.py` is a
stdlib-only replay server over hand-built data in Atlassian's documented response shapes:
a Jira Cloud site with Confluence (`/cloud`), a Jira Data Center site (`/dc`) and the
OAuth gateway (`/gw`). It enforces auth, rejects unknown query parameters, **parses and
evaluates the JQL and CQL it receives** (`test/mock_api/ql.py`), so a wrong pushdown
returns wrong rows, returns only the fields named in `fields=`, rejects unbounded
enhanced searches, pages with small caps, and answers a 429 and a 503 once each so the
retry paths always run. The SQL tests read its `/__requests` log to check exactly what
was pushed down.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm
