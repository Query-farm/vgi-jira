// Unit tests for the translation and parsing logic. The SQL-level tests live in
// test/sql and run through DuckDB against the replay server.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  AtlassianError,
  atlassianGet,
  clearDeploymentCache,
  configFromSecrets,
  resolveDeployment,
  retryDelayMs,
} from "../src/atlassian/client.ts";
import { andJoin, buildClauses, type Constraint, quote, splitOrderBy } from "../src/atlassian/pushdown.ts";
import { asTime, parsePage } from "../src/atlassian/table.ts";
import { adfToText, storageToText } from "../src/atlassian/text.ts";
import { bounded, findField, parseSprint } from "../src/jira/common.ts";
import { parseHoists, simplify } from "../src/jira/issues.ts";

const ROOT = join(import.meta.dir, "..");
const secret = (fields: Record<string, string>) => ({ s: { type: "atlassian", ...fields } });

describe("JQL text", () => {
  test("quote escapes quotes, backslashes and control characters", () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(quote("line\nbreak")).toBe('"line\\nbreak"');
    expect(quote("AND")).toBe('"AND"');
  });

  test("splitOrderBy ignores ORDER BY inside strings", () => {
    expect(splitOrderBy('summary ~ "order by x" ORDER BY created DESC')).toEqual({
      where: 'summary ~ "order by x"',
      orderBy: "ORDER BY created DESC",
    });
    expect(splitOrderBy("ORDER BY key")).toEqual({ where: "", orderBy: "ORDER BY key" });
  });

  test("andJoin parenthesises the user query and keeps its ordering", () => {
    expect(andJoin("a = 1 OR b = 2 order by rank", ['c = "x"'])).toBe('(a = 1 OR b = 2) AND c = "x" order by rank');
    expect(andJoin(null, [], "ORDER BY key ASC")).toBe("ORDER BY key ASC");
    expect(bounded("ORDER BY key ASC")).toBe('created >= "1970-01-01" ORDER BY key ASC');
  });

  test("buildClauses: eq, IN, EMPTY, list_contains, widened time ranges", () => {
    const cs: Constraint[] = [
      { kind: "cmp", column: "status", op: "eq", value: "In Progress" },
      { kind: "in", column: "key", values: ["A-1", "A-2"] },
      { kind: "null", column: "assignee", negated: false },
      { kind: "contains", column: "labels", value: "x" },
      { kind: "cmp", column: "created_at", op: "ge", value: BigInt(Date.UTC(2026, 0, 2)) * 1000n },
      { kind: "cmp", column: "unmapped", op: "eq", value: "z" },
      { kind: "cmp", column: "status", op: "gt", value: "A" },
    ];
    expect(
      buildClauses(cs, {
        status: { field: "status", kind: "string" },
        key: { field: "key", kind: "string" },
        assignee: { field: "assignee", kind: "string", empty: true },
        labels: { field: "labels", kind: "list" },
        created_at: { field: "created", kind: "time" },
      }),
    ).toEqual([
      'status = "In Progress"',
      'key in ("A-1", "A-2")',
      "assignee is EMPTY",
      'labels = "x"',
      'created >= "2025-12-31 22:00"',
    ]);
  });
});

describe("rich text", () => {
  test("ADF: paragraphs, mentions, lists, code, tables", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hi " },
            { type: "mention", attrs: { text: "@Ada" } },
          ],
        },
        {
          type: "orderedList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }],
        },
        { type: "codeBlock", content: [{ type: "text", text: "x = 1" }] },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("Hi @Ada\n1. one\nx = 1\na\tb");
    expect(adfToText("wiki *markup*")).toBe("wiki *markup*");
    expect(adfToText(null)).toBeNull();
  });

  test("storage format: entities, lists, CDATA, users", () => {
    expect(
      storageToText(
        '<p>A &amp; B&nbsp;&#x263A;</p><ul><li>x</li></ul><ac:link><ri:user ri:account-id="u1"/></ac:link><![CDATA[raw <b>]]>',
      ),
    ).toBe("A & B ☺\n- x\n@u1raw <b>");
  });
});

describe("parsing", () => {
  test("Jira timestamps with +0000 offsets", () => {
    expect(asTime("2026-09-01T09:00:00.000+0000")).toBe(BigInt(Date.UTC(2026, 8, 1, 9)) * 1000n);
    expect(asTime("2026-09-01T11:00:00.000+0200")).toBe(BigInt(Date.UTC(2026, 8, 1, 9)) * 1000n);
  });

  test("sprints: Cloud objects and Data Center strings", () => {
    expect(parseSprint({ id: 2, name: "S2", state: "active" })).toEqual({ id: 2n, name: "S2", state: "active" });
    expect(parseSprint("x.Sprint@1[id=7,rapidViewId=5,state=ACTIVE,name=LEG Sprint 7,goal=]")).toEqual({
      id: 7n,
      name: "LEG Sprint 7",
      state: "ACTIVE",
    });
  });

  test("custom_fields ATTACH option", () => {
    expect(parseHoists("sp=Story point estimate:DOUBLE, team = customfield_10030, s=Sprint:list")).toEqual([
      { column: "sp", ref: "Story point estimate", type: "DOUBLE" },
      { column: "team", ref: "customfield_10030", type: "VARCHAR" },
      { column: "s", ref: "Sprint", type: "VARCHAR[]" },
    ]);
    expect(() => parseHoists("key=Summary")).toThrow(/already exists/);
    expect(() => parseHoists("x=Y:BLOB")).toThrow(/type 'BLOB'/);
    expect(parseHoists(undefined)).toEqual([]);
  });

  test("field lookup by id, cf[N] and name", () => {
    const fields = [{ id: "customfield_10016", name: "Story point estimate", custom: true }];
    expect(findField(fields, "cf[10016]")?.id).toBe("customfield_10016");
    expect(findField(fields, "story POINT estimate")?.id).toBe("customfield_10016");
    expect(findField(fields, "nope")).toBeUndefined();
  });

  test("simplify custom field values", () => {
    expect(simplify({ value: "SRE", id: "1" })).toBe("SRE");
    expect(simplify([{ displayName: "Ada" }, "x"])).toEqual(["Ada", "x"]);
  });

  test("Retry-After seconds, HTTP date and X-RateLimit-Reset", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(retryDelayMs(new Headers({ "Retry-After": "2" }), now)).toBe(2000);
    expect(retryDelayMs(new Headers({ "X-RateLimit-Reset": new Date(now + 3000).toISOString() }), now)).toBe(3100);
    expect(retryDelayMs(new Headers({}), now)).toBeUndefined();
  });

  test("paging: offset/isLast, token, links", () => {
    const cfg = configFromSecrets(secret({ site_url: "https://acme.atlassian.net", email: "a@b.c", api_token: "t" }));
    const off = parsePage(
      cfg,
      { url: "", paging: { style: "offset", key: "values" } },
      "https://acme.atlassian.net/x?maxResults=2",
      {
        startAt: 0,
        maxResults: 2,
        isLast: false,
        values: [{}, {}],
      },
    );
    expect(off.next).toBe("https://acme.atlassian.net/x?maxResults=2&startAt=2");
    const tok = parsePage(cfg, { url: "", paging: { style: "token", key: "issues" } }, "https://acme.atlassian.net/s", {
      issues: [{}],
      nextPageToken: "abc",
    });
    expect(tok.next).toBe("https://acme.atlassian.net/s?nextPageToken=abc");
    const v2 = parsePage(cfg, { url: "", paging: { style: "links" } }, "", {
      results: [{}],
      _links: { next: "/wiki/api/v2/spaces?cursor=z" },
    });
    expect(v2.next).toBe("https://acme.atlassian.net/wiki/api/v2/spaces?cursor=z");
    const v1 = parsePage(cfg, { url: "", paging: { style: "links" } }, "", {
      results: [{}],
      _links: { next: "/rest/api/search?cursor=z" },
    });
    expect(v1.next).toBe("https://acme.atlassian.net/wiki/rest/api/search?cursor=z");
  });
});

describe("secret handling", () => {
  test("auth header per credential kind", () => {
    const basic = configFromSecrets(
      secret({ site_url: "https://acme.atlassian.net/", email: "a@b.c", api_token: "t" }),
    );
    expect(basic.auth).toBe(`Basic ${Buffer.from("a@b.c:t").toString("base64")}`);
    expect(basic.siteUrl).toBe("https://acme.atlassian.net");
    const pat = configFromSecrets(secret({ site_url: "https://jira.corp/jira", personal_access_token: "p" }));
    expect(pat.auth).toBe("Bearer p");
    expect(pat.jiraBase).toBe("https://jira.corp/jira");
    const oauth = configFromSecrets(
      secret({
        site_url: "https://acme.atlassian.net",
        oauth_access_token: "o",
        cloud_id: "11111111-2222-3333-4444-555555555555",
      }),
    );
    expect(oauth.jiraBase).toBe("https://api.atlassian.com/ex/jira/11111111-2222-3333-4444-555555555555");
    expect(oauth.confluenceBase).toBe("https://api.atlassian.com/ex/confluence/11111111-2222-3333-4444-555555555555");
  });

  test("rejects missing credentials, plain http and bad deployment", () => {
    expect(() => configFromSecrets({})).toThrow(/no atlassian secret/);
    expect(() =>
      configFromSecrets(secret({ site_url: "http://acme.atlassian.net", email: "a", api_token: "b" })),
    ).toThrow(/https/);
    expect(() => configFromSecrets(secret({ site_url: "https://a.atlassian.net", email: "a" }))).toThrow(/API_TOKEN/);
    expect(() =>
      configFromSecrets(secret({ site_url: "https://a.atlassian.net", email: "a", api_token: "b", deployment: "x" })),
    ).toThrow(/deployment/);
  });

  test("never sends credentials off-site", async () => {
    const cfg = configFromSecrets(secret({ site_url: "https://acme.atlassian.net", email: "a@b.c", api_token: "t" }));
    await expect(atlassianGet(cfg, "https://evil.example.com/rest/api/3/field")).rejects.toThrow(AtlassianError);
  });
});

describe("against the replay server", () => {
  let mock: ReturnType<typeof Bun.spawn>;
  let base: string;

  beforeAll(async () => {
    mock = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_api", "server.py")], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const port = text.match(/^PORT:(\d+)/)?.[1];
    if (!port) throw new Error(`replay server did not report a port: ${text}`);
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    mock?.kill();
  });

  test("detects Cloud vs Data Center", async () => {
    clearDeploymentCache();
    const cloud = configFromSecrets(
      secret({ site_url: `${base}/cloud`, email: "ada@example.com", api_token: "cloud-token" }),
    );
    const dc = configFromSecrets(secret({ site_url: `${base}/dc`, personal_access_token: "dc-pat" }));
    expect(await resolveDeployment(cloud)).toBe("cloud");
    expect(await resolveDeployment(dc)).toBe("datacenter");
  });

  test("retries a 429 with Retry-After and a 503", async () => {
    const cfg = configFromSecrets(
      secret({ site_url: `${base}/cloud`, email: "ada@example.com", api_token: "cloud-token" }),
    );
    const t0 = Date.now();
    const prio = (await atlassianGet(cfg, `${base}/cloud/rest/api/3/priority`)) as unknown[];
    expect(prio.length).toBe(5);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    const st = (await atlassianGet(cfg, `${base}/cloud/rest/api/3/status`)) as unknown[];
    expect(st.length).toBe(4);
  });

  test("HTTP errors carry the status and Jira's message", async () => {
    const cfg = configFromSecrets(
      secret({ site_url: `${base}/cloud`, email: "ada@example.com", api_token: "cloud-token" }),
    );
    await expect(atlassianGet(cfg, `${base}/cloud/rest/api/3/search/jql`, { jql: "" })).rejects.toThrow(
      /HTTP 400.*Unbounded/,
    );
    await expect(atlassianGet(cfg, `${base}/cloud/rest/api/3/field`, { bogus: "1" })).rejects.toThrow(
      /HTTP 400.*bogus/,
    );
  });
});
