/**
 * Assemble the `jira` catalog: schema `main` (Jira) and schema `confluence`, the
 * `atlassian` secret type and the `custom_fields` ATTACH option.
 */

import { type CatalogDescriptor, field, schema, utf8, type VgiFunction } from "@query-farm/vgi";
import { SECRET_TYPE } from "./atlassian/client.ts";
import { CONFLUENCE_FUNCTIONS, CONFLUENCE_TABLES } from "./confluence/resources.ts";
import { issues } from "./jira/issues.ts";
import { JIRA_FUNCTIONS, JIRA_TABLES } from "./jira/resources.ts";
import {
  CATALOG_COMMENT,
  CATALOG_NAME,
  CATALOG_TAGS,
  CONFLUENCE_DOC_MD,
  CONFLUENCE_SCHEMA_TAGS,
  SCHEMA_DOC_MD,
  SCHEMA_TAGS,
  SOURCE_URL,
} from "./meta.ts";

export const FUNCTIONS: VgiFunction[] = [issues, ...JIRA_FUNCTIONS];

const doc = (text: string) => new Map([["vgi_doc", text]]);
const redacted = (text: string) =>
  new Map([
    ["redact", "true"],
    ["vgi_doc", text],
  ]);

/** CREATE SECRET (TYPE atlassian, SITE_URL '…', EMAIL '…', API_TOKEN '…') — or a PAT / OAuth token. */
export const ATLASSIAN_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "Atlassian site URL plus an API token (Cloud), a personal access token (Data Center) or an OAuth token",
  schema: schema(
    [
      field(
        "site_url",
        utf8(),
        true,
        doc(
          "Site URL as you browse it: https://acme.atlassian.net (Cloud) or https://jira.example.com/jira (Data Center). http:// only for 127.0.0.1/localhost.",
        ),
      ),
      field("email", utf8(), true, doc("Atlassian account email for API-token basic auth (Data Center: a username).")),
      field("api_token", utf8(), true, redacted("API token from id.atlassian.com (Data Center: the user's password).")),
      field("personal_access_token", utf8(), true, redacted("Data Center personal access token (sent as Bearer).")),
      field("oauth_access_token", utf8(), true, redacted("OAuth 2.0 (3LO) access token with read scopes.")),
      field(
        "cloud_id",
        utf8(),
        true,
        doc("With an OAuth token: the site's cloud id, to route through https://api.atlassian.com/ex/jira/<cloud_id>."),
      ),
      field(
        "api_gateway_url",
        utf8(),
        true,
        doc("Override of the OAuth API gateway (default https://api.atlassian.com)."),
      ),
      field(
        "deployment",
        utf8(),
        true,
        doc("auto (default: detect from /rest/api/2/serverInfo), cloud or datacenter."),
      ),
    ],
    new Map([
      [
        "vgi_doc_url",
        "https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/",
      ],
    ]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; return them all for the schema. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const ex = (fn.meta.examples ?? []).map((e) => ({ description: e.description, sql: e.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(ex) };
    all.push(...ex);
  }
  return all;
}

const tableExamples = (tables: { tags?: Record<string, string> }[]) =>
  tables.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]);

const JIRA_EXAMPLES = [...stampExampleQueries(FUNCTIONS), ...tableExamples(JIRA_TABLES)];
const CONFLUENCE_EXAMPLES = [...stampExampleQueries(CONFLUENCE_FUNCTIONS), ...tableExamples(CONFLUENCE_TABLES)];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [ATLASSIAN_SECRET_TYPE],
  attachOptions: [
    {
      name: "custom_fields",
      description:
        "Hoist Jira custom fields into typed issues() columns: 'column=Field name or customfield_N[:TYPE], …' " +
        "(TYPE: VARCHAR, DOUBLE, BIGINT, BOOLEAN, DATE, TIMESTAMPTZ, VARCHAR[], JSON; default VARCHAR).",
      type: utf8(),
      default: null,
    },
  ],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: FUNCTIONS,
      tables: JIRA_TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(JIRA_EXAMPLES.slice(0, 12)) },
    },
    {
      path: ["confluence"],
      comment: CONFLUENCE_DOC_MD,
      functions: CONFLUENCE_FUNCTIONS,
      tables: CONFLUENCE_TABLES,
      tags: { ...CONFLUENCE_SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(CONFLUENCE_EXAMPLES) },
    },
  ],
};
