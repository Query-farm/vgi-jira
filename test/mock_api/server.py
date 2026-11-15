#!/usr/bin/env python3
"""An offline Atlassian (Jira Cloud + Data Center, Confluence Cloud) replay server (stdlib only).

It serves the hand-built data in ``fixtures.py`` (documented response shapes) and
behaves like Atlassian where the worker depends on it:

* **Sites.** ``/cloud`` is Jira Cloud (REST v3 + Agile, ``serverInfo`` says Cloud;
  ``/rest/api/2/*`` other than serverInfo and the retired ``/rest/api/3/search`` are
  refused) with Confluence Cloud under ``/cloud/wiki``. ``/dc`` is Jira Data Center
  (REST v2 only, classic ``/search``). ``/gw/ex/jira/<cloud-id>`` and
  ``/gw/ex/confluence/<cloud-id>`` emulate the OAuth API gateway for the Cloud site.
* **Auth.** Cloud site paths: ``Basic ada@example.com:cloud-token``. Gateway paths:
  ``Bearer oauth-token``. Data Center: ``Bearer dc-pat`` or ``Basic jsmith:dc-password``.
  Anything else is a 401.
* **Strict queries.** Every route accepts only its documented parameters (unknown ones
  are a 400); JQL and CQL are parsed (``ql.py``) and EVALUATED against the fixtures, so
  wrong pushdown returns wrong rows and bad quoting is a 400. Unknown JQL/CQL fields are
  a 400 like Jira's. Cloud's enhanced search rejects unbounded JQL, returns only the
  fields named in ``fields=`` (``key`` too), and pages with an opaque nextPageToken.
* **Paging.** Small page caps (changelog 2, Confluence search 3, spaces 2, …) so every
  cursor path runs.
* **Rate limits.** The first ``/cloud/rest/api/3/priority`` answers 429 (Retry-After: 1),
  the first ``/cloud/rest/api/3/status`` 503 (Retry-After: 1), the first Confluence
  spaces request 429 with only ``X-RateLimit-Reset`` (ISO 8601, one second out).
* **Introspection.** ``GET /__requests?path=<path>`` returns every recorded request to
  that path (``seq``, ``path``, ``query`` as a JSON object string, ``auth``) so SQL tests
  can assert exactly what was pushed down; ``/__reset`` clears the log.

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fixtures as F  # noqa: E402
import ql  # noqa: E402

CLOUD_ID = "11111111-2222-3333-4444-555555555555"
CLOUD_BASIC = "Basic " + base64.b64encode(b"ada@example.com:cloud-token").decode()
OAUTH = "Bearer oauth-token"
DC_AUTH = {"Bearer dc-pat", "Basic " + base64.b64encode(b"jsmith:dc-password").decode()}
NOW = dt.datetime(2026, 11, 10, 12, 0, tzinfo=dt.timezone.utc)

LOCK = threading.Lock()
REQUESTS: list[dict] = []
FAILED_ONCE: set[str] = set()


class HttpError(Exception):
    def __init__(self, status: int, body: dict, headers: dict | None = None):
        super().__init__(status)
        self.status, self.body, self.headers = status, body, headers or {}


def jira_error(status: int, msg: str) -> HttpError:
    return HttpError(status, {"errorMessages": [msg], "errors": {}})


def wiki_error(status: int, msg: str, v2: bool) -> HttpError:
    if v2:
        return HttpError(status, {"errors": [{"status": status, "code": "INVALID_REQUEST_PARAMETER", "title": msg, "detail": None}]})
    return HttpError(status, {"statusCode": status, "message": msg})


def only(query: dict, allowed: set[str], err=jira_error) -> None:
    for k in query:
        if k not in allowed:
            raise err(400, f"Unrecognized query parameter '{k}'")


def one(query: dict, k: str, default: str | None = None) -> str | None:
    v = query.get(k)
    return v[-1] if v else default


def int_param(query: dict, k: str, default: int, lo: int = 0, err=jira_error) -> int:
    v = one(query, k)
    if v is None:
        return default
    if not re.fullmatch(r"\d+", v) or int(v) < lo:
        raise err(400, f"'{k}' must be an integer >= {lo}")
    return int(v)


def offset_page(items: list, query: dict, key: str, cap: int, default: int = 50, **extra) -> dict:
    start = int_param(query, "startAt", 0)
    size = min(int_param(query, "maxResults", default, 1), cap)
    chunk = items[start : start + size]
    return {"startAt": start, "maxResults": size, "total": len(items), "isLast": start + size >= len(items), key: chunk, **extra}


# ------------------------------------------------------------------------ JQL


def key_sort(key: str):
    p, n = key.rsplit("-", 1)
    return (p, int(n))


def jql_resolver(site: str):
    def users(u):
        if not u:
            return []
        return [u.get("accountId"), u.get("name"), u.get("key")]

    def sprint_values(f):
        out = []
        for s in f.get("customfield_10020" if site == "cloud" else "customfield_10100") or []:
            if isinstance(s, dict):
                out += [s["id"], s["name"]]
            else:
                m = re.search(r"\[id=(\d+).*?name=([^,\]]*)", s)
                if m:
                    out += [int(m.group(1)), m.group(2)]
        return out

    def resolve(issue: dict, field: str):
        f = issue["fields"]
        name = field.lower()
        cf = re.fullmatch(r"cf\[(\d+)\]", name)
        if cf:
            cid = f"customfield_{cf.group(1)}"
            if cid not in f:
                return None
            v = f[cid]
            if isinstance(v, dict):
                return [v.get("value")]
            return v if isinstance(v, list) else [v]
        table = {
            "project": lambda: [f["project"]["key"], f["project"]["name"], f["project"]["id"]],
            "key": lambda: [issue["key"]],
            "issuekey": lambda: [issue["key"]],
            "id": lambda: [issue["id"]],
            "issuetype": lambda: [f["issuetype"]["name"], f["issuetype"]["id"]],
            "type": lambda: [f["issuetype"]["name"], f["issuetype"]["id"]],
            "status": lambda: [f["status"]["name"], f["status"]["id"]],
            "statuscategory": lambda: [f["status"]["statusCategory"][k] for k in ("name", "key", "id")],
            "assignee": lambda: users(f.get("assignee")),
            "reporter": lambda: users(f.get("reporter")),
            "creator": lambda: users(f.get("creator")),
            "labels": lambda: list(f.get("labels") or []),
            "priority": lambda: [f["priority"]["name"], f["priority"]["id"]] if f.get("priority") else [],
            "resolution": lambda: [f["resolution"]["name"]] if f.get("resolution") else [],
            "created": lambda: [f["created"]],
            "updated": lambda: [f["updated"]],
            "resolved": lambda: [f.get("resolutiondate")],
            "resolutiondate": lambda: [f.get("resolutiondate")],
            "summary": lambda: [f["summary"]],
            "text": lambda: [f["summary"], json.dumps(f.get("description"))],
            "component": lambda: [c["name"] for c in f.get("components") or []],
            "fixversion": lambda: [v["name"] for v in f.get("fixVersions") or []],
            "affectedversion": lambda: [v["name"] for v in f.get("versions") or []],
            "sprint": lambda: sprint_values(f),
        }
        if site == "cloud":
            table["parent"] = lambda: [f["parent"]["key"]] if f.get("parent") else []
            table["story point estimate"] = lambda: [f.get("customfield_10016")]
            table["team"] = lambda: [f["customfield_10030"]["value"]] if f.get("customfield_10030") else []
        fn = table.get(name)
        return fn() if fn else None

    return resolve


def jql_functions(site: str, auth_user: str):
    def fn(name: str, field: str) -> list:
        if name == "subtaskissuetypes":
            return [t["name"] for t in F.ISSUE_TYPES.values() if t["subtask"]]
        if name == "standardissuetypes":
            return [t["name"] for t in F.ISSUE_TYPES.values() if not t["subtask"]]
        if name in ("opensprints", "closedsprints", "futuresprints"):
            state = {"opensprints": "active", "closedsprints": "closed", "futuresprints": "future"}[name]
            if site == "dc":
                return [7] if state == "active" else []
            return [s["id"] for s in F.SPRINT_BY_ID.values() if s["state"] == state]
        if name == "currentuser":
            return [auth_user]
        raise ql.QLError(f"Unable to find JQL function '{name}()'.")

    return fn


def run_jql(site: str, jql: str, auth_user: str, require_bound: bool) -> list[dict]:
    try:
        expr, order = ql.parse(jql) if (jql or "").strip() else (None, [])
    except ql.QLError as e:
        raise jira_error(400, str(e)) from None
    if require_bound and expr is None:
        raise jira_error(400, "Unbounded JQL queries are not allowed here. Please add a search restriction to your query.")
    data = F.CLOUD_ISSUES if site == "cloud" else F.DC_ISSUES
    resolve = jql_resolver(site)
    try:
        hits = [i for i in data if ql.evaluate(expr, i, resolve, jql_functions(site, auth_user), NOW)]
    except ql.QLError as e:
        raise jira_error(400, str(e)) from None
    for fld, desc in reversed(order or [("key", False)]):
        f = fld.lower()
        if f in ("key", "issuekey"):
            hits.sort(key=lambda i: key_sort(i["key"]), reverse=desc)
        else:
            vals = {i["key"]: resolve(i, f) for i in hits}
            if vals and all(v is None for v in vals.values()):
                raise jira_error(400, f"Not able to sort using field '{fld}'.")
            hits.sort(key=lambda i: str((vals[i["key"]] or [""])[0] or ""), reverse=desc)
    return hits


def project_fields(issue: dict, fields_param: str | None, site: str, cloud_enhanced: bool, expand: str | None) -> dict:
    wanted = [x.strip() for x in (fields_param or ("id" if cloud_enhanced else "*navigable")).split(",") if x.strip()]
    all_fields = "*all" in wanted or "*navigable" in wanted
    out = {"id": issue["id"], "self": f"/rest/api/issue/{issue['id']}"}
    if not cloud_enhanced or all_fields or "key" in wanted:
        out["key"] = issue["key"]
    fields = {k: v for k, v in issue["fields"].items() if all_fields or k in wanted}
    if fields:
        out["fields"] = fields
    if expand and "changelog" in expand.split(","):
        hist = (F.CHANGELOG if site == "cloud" else F.DC_CHANGELOG).get(issue["key"], [])
        out["changelog"] = {"startAt": 0, "maxResults": len(hist), "total": len(hist), "histories": hist}
    return out


def tok(n: int) -> str:
    return base64.urlsafe_b64encode(f"offset:{n}".encode()).decode()


def untok(t: str) -> int:
    try:
        m = re.fullmatch(r"offset:(\d+)", base64.urlsafe_b64decode(t.encode()).decode())
    except Exception:
        m = None
    if not m:
        raise jira_error(400, "The provided next page token is invalid or expired.")
    return int(m.group(1))


# ------------------------------------------------------------------------ CQL


def cql_resolve(p: dict, field: str):
    name = field.lower()
    table = {
        "space": lambda: [p["space"]["key"]],
        "space.key": lambda: [p["space"]["key"]],
        "type": lambda: [p["type"]],
        "label": lambda: [x["name"] for x in p["metadata"]["labels"]["results"]],
        "title": lambda: [p["title"]],
        "text": lambda: [p["title"], p["body"]["storage"]["value"]],
        "id": lambda: [p["id"]],
        "content": lambda: [p["id"]],
        "parent": lambda: [p["ancestors"][-1]["id"]] if p["ancestors"] else [],
        "ancestor": lambda: [a["id"] for a in p["ancestors"]],
        "creator": lambda: [p["history"]["createdBy"]["accountId"]],
        "contributor": lambda: [p["version"]["by"]["accountId"], p["history"]["createdBy"]["accountId"]],
        "created": lambda: [p["history"]["createdDate"]],
        "lastmodified": lambda: [p["version"]["when"]],
    }
    fn = table.get(name)
    return fn() if fn else None


CONTENT_EXPANDS = {
    "content.space": "space",
    "content.history": "history",
    "content.version": "version",
    "content.metadata.labels": "metadata",
    "content.ancestors": "ancestors",
    "content.body.storage": "body",
}


def search_result(p: dict, expand: list[str], base: str) -> dict:
    content = {"id": p["id"], "type": p["type"], "status": p["status"], "title": p["title"], "_links": p["_links"]}
    for e in expand:
        content[CONTENT_EXPANDS[e]] = p[CONTENT_EXPANDS[e]]
    body_text = re.sub(r"<[^>]+>", " ", p["body"]["storage"]["value"])
    return {
        "content": content,
        "title": p["title"],
        "excerpt": re.sub(r"\s+", " ", body_text).strip()[:60],
        "url": p["_links"]["webui"],
        "resultGlobalContainer": {"title": p["space"]["name"], "displayUrl": f"/spaces/{p['space']['key']}"},
        "entityType": "content",
        "lastModified": p["version"]["when"],
    }


def cursor_page(items: list, query: dict, cap: int, link_path: str, v2: bool, extra_query: dict | None = None) -> dict:
    err = lambda s, m: wiki_error(s, m, v2)  # noqa: E731
    start = 0
    c = one(query, "cursor")
    if c:
        try:
            start = int(base64.urlsafe_b64decode(c.encode()).decode().split(":")[1])
        except Exception:
            raise err(400, "Invalid cursor") from None
    size = min(int_param(query, "limit", 25, 1, err), cap)
    chunk = items[start : start + size]
    out: dict = {"results": chunk, "_links": {}}
    if start + size < len(items):
        q = {k: v[-1] for k, v in query.items() if k != "cursor"}
        q.update(extra_query or {})
        q["cursor"] = base64.urlsafe_b64encode(f"c:{start + size}".encode()).decode()
        out["_links"]["next"] = f"{link_path}?{urlencode(q, quote_via=quote)}"
    return out


# --------------------------------------------------------------------- routing


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quiet
        pass

    def send(self, status: int, body, headers: dict | None = None) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-RateLimit-Limit", "100")
        self.send_header("X-RateLimit-Remaining", "99")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        query = parse_qs(url.query, keep_blank_values=True)
        if url.path == "/health":
            return self.send(200, {"status": "ok"})
        if url.path == "/__requests":
            with LOCK:
                rows = [r for r in REQUESTS if not query.get("path") or r["path"] == query["path"][0]]
            return self.send(200, rows)
        if url.path == "/__reset":
            with LOCK:
                REQUESTS.clear()
            return self.send(200, {"ok": True})
        auth = self.headers.get("Authorization", "")
        with LOCK:
            REQUESTS.append({
                "seq": len(REQUESTS) + 1,
                "path": url.path,
                "query": json.dumps({k: (v[0] if len(v) == 1 else v) for k, v in query.items()}),
                "auth": auth.split(" ")[0] if auth else "none",
            })
        try:
            status, body, headers = self.route(url.path, query, auth)
            self.send(status, body, headers)
        except HttpError as e:
            self.send(e.status, e.body, e.headers)

    def route(self, path: str, query: dict, auth: str):
        origin = f"http://{self.headers.get('Host')}"
        m = re.fullmatch(rf"/gw/ex/(jira|confluence)/{CLOUD_ID}(/.*)", path)
        if m:
            if auth != OAUTH:
                raise jira_error(401, "Unauthorized; scope does not match")
            site, rest = "cloud", m.group(2)
            wiki_base = f"{origin}/gw/ex/confluence/{CLOUD_ID}/wiki"
            if (m.group(1) == "confluence") != rest.startswith("/wiki/"):
                raise jira_error(404, "No route")
        else:
            m = re.fullmatch(r"/(cloud|dc)(/.*)", path)
            if not m:
                raise jira_error(404, f"No such site: {path}")
            site, rest = m.group(1), m.group(2)
            ok = auth == CLOUD_BASIC if site == "cloud" else auth in DC_AUTH
            if not ok:
                if rest.startswith("/wiki/"):
                    raise wiki_error(401, "Unauthorized", rest.startswith("/wiki/api/v2"))
                raise HttpError(401, {"errorMessages": ["You do not have permission to see the specified resource; authentication failed."], "errors": {}})
            wiki_base = f"{origin}/cloud/wiki"
        auth_user = "acc-ada" if site == "cloud" else "jsmith"

        # One-shot failures so the retry paths always run.
        for fail_path, status, hdrs in (
            ("/cloud/rest/api/3/priority", 429, {"Retry-After": "1"}),
            ("/cloud/rest/api/3/status", 503, {"Retry-After": "1"}),
            ("/cloud/wiki/api/v2/spaces", 429, None),
        ):
            if path == fail_path:
                with LOCK:
                    first = fail_path not in FAILED_ONCE
                    FAILED_ONCE.add(fail_path)
                if first:
                    hdrs = hdrs or {"X-RateLimit-Reset": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=1)).isoformat()}
                    raise HttpError(status, {"errorMessages": ["Rate limit exceeded."]}, {**hdrs, "X-RateLimit-Remaining": "0"})

        if rest.startswith("/wiki/"):
            if site != "cloud":
                raise jira_error(404, "Confluence is not installed on this site")
            return self.confluence(rest[len("/wiki") :], query, wiki_base)
        return self.jira(site, rest, query, auth_user)

    # ---------------------------------------------------------------- Jira

    def jira(self, site: str, rest: str, query: dict, auth_user: str):
        if rest == "/rest/api/2/serverInfo":
            only(query, set())
            dep = "Cloud" if site == "cloud" else "DataCenter"
            return 200, {"baseUrl": "", "version": "1001.0.0" if site == "cloud" else "9.12.0", "deploymentType": dep}, None
        m = re.fullmatch(r"/rest/agile/1\.0(/.*)", rest)
        if m:
            return self.agile(site, m.group(1), query)
        m = re.fullmatch(r"/rest/api/(2|3)(/.*)", rest)
        if not m:
            raise jira_error(404, f"No route {rest}")
        ver, sub = m.group(1), m.group(2)
        if (site == "cloud") != (ver == "3"):
            raise jira_error(404, f"REST API v{ver} is not served by this {'Cloud' if site == 'cloud' else 'Data Center'} fixture")
        projects = F.CLOUD_PROJECTS if site == "cloud" else F.DC_PROJECTS
        issues = F.CLOUD_BY_KEY if site == "cloud" else {i["key"]: i for i in F.DC_ISSUES}

        if sub == "/search/jql":
            if site != "cloud":
                raise jira_error(404, "No route")
            only(query, {"jql", "nextPageToken", "maxResults", "fields", "expand"})
            hits = run_jql(site, one(query, "jql", ""), auth_user, require_bound=True)
            start = untok(one(query, "nextPageToken")) if one(query, "nextPageToken") else 0
            size = min(int_param(query, "maxResults", 50, 1), 100)
            chunk = hits[start : start + size]
            body = {"issues": [project_fields(i, one(query, "fields"), site, True, one(query, "expand")) for i in chunk], "isLast": start + size >= len(hits)}
            if start + size < len(hits):
                body["nextPageToken"] = tok(start + size)
            return 200, body, None
        if sub == "/search":
            if site == "cloud":
                raise jira_error(410, "The requested API has been removed. Please migrate to the /rest/api/3/search/jql API.")
            only(query, {"jql", "startAt", "maxResults", "fields", "expand", "validateQuery"})
            hits = run_jql(site, one(query, "jql", ""), auth_user, require_bound=False)
            page = offset_page(hits, query, "issues", 100, expand=one(query, "expand", ""))
            page["issues"] = [project_fields(i, one(query, "fields"), site, False, one(query, "expand")) for i in page["issues"]]
            return 200, page, None
        if sub in ("/field", "/status", "/priority", "/issuetype"):
            only(query, set())
            if sub == "/field":
                return 200, F.SYSTEM_FIELDS + (F.CLOUD_CUSTOM if site == "cloud" else F.DC_CUSTOM), None
            if sub == "/status":
                return 200, list(F.STATUSES.values()), None
            if sub == "/priority":
                return 200, F.PRIORITIES, None
            return 200, list(F.ISSUE_TYPES.values()), None
        if sub == "/project/search":
            if site != "cloud":
                raise jira_error(404, "No route")
            only(query, {"startAt", "maxResults", "keys", "expand", "query", "orderBy", "id"})
            keys = query.get("keys")
            ps = [p for p in projects if not keys or p["key"] in keys]
            return 200, offset_page(ps, query, "values", 1, self=""), None
        if sub == "/project":
            if site == "cloud":
                raise jira_error(410, "Use /rest/api/3/project/search")
            only(query, {"expand", "recent", "includeArchived"})
            return 200, projects, None
        m = re.fullmatch(r"/project/([^/]+)/(components|versions|statuses)", sub)
        if m:
            only(query, set())
            key = m.group(1)
            if key not in {p["key"] for p in projects}:
                raise jira_error(404, f"No project could be found with key '{key}'.")
            if m.group(2) == "components":
                return 200, F.COMPONENTS.get(key, []), None
            if m.group(2) == "versions":
                return 200, F.VERSIONS.get(key, []), None
            types = F.PROJECT_TYPES.get(key, ["Task"])
            return 200, [
                {**F.ISSUE_TYPES[t], "statuses": [F.STATUSES[s] for s in F.WORKFLOW[t]]} for t in types
            ], None
        m = re.fullmatch(r"/issue/([^/]+)/(changelog|comment|worklog)", sub)
        if m:
            key, what = m.group(1), m.group(2)
            if key not in issues:
                raise jira_error(404, "Issue does not exist or you do not have permission to see it.")
            if what == "changelog":
                if site != "cloud":
                    raise jira_error(404, "No route")
                only(query, {"startAt", "maxResults"})
                return 200, offset_page(F.CHANGELOG.get(key, []), query, "values", 2, 100), None
            if what == "comment":
                only(query, {"startAt", "maxResults", "orderBy", "expand"})
                src = F.COMMENTS if site == "cloud" else F.DC_COMMENTS
                return 200, offset_page(src.get(key, []), query, "comments", 100), None
            only(query, {"startAt", "maxResults", "startedAfter", "startedBefore", "expand"})
            return 200, offset_page(F.WORKLOGS.get(key, []) if site == "cloud" else [], query, "worklogs", 1000, 1000), None
        if sub == "/users/search" and site == "cloud":
            only(query, {"startAt", "maxResults"})
            start = int_param(query, "startAt", 0)
            size = min(int_param(query, "maxResults", 50, 1), 2)
            return 200, list(F.USERS.values())[start : start + size], None
        if sub == "/user/search" and site == "dc":
            only(query, {"username", "startAt", "maxResults", "includeActive", "includeInactive"})
            if not one(query, "username"):
                raise jira_error(400, "The username query parameter was not provided")
            start = int_param(query, "startAt", 0)
            size = min(int_param(query, "maxResults", 50, 1), 1000)
            return 200, list(F.DC_USERS.values())[start : start + size], None
        raise jira_error(404, f"No route {sub}")

    def agile(self, site: str, sub: str, query: dict):
        boards = F.BOARDS if site == "cloud" else []
        if sub == "/board":
            only(query, {"startAt", "maxResults", "type", "name", "projectKeyOrId", "includePrivate", "orderBy"})
            bs = boards
            if one(query, "type"):
                types = one(query, "type").split(",")
                bs = [b for b in bs if b["type"] in types]
            if one(query, "name"):
                bs = [b for b in bs if one(query, "name").lower() in b["name"].lower()]
            if one(query, "projectKeyOrId"):
                pk = one(query, "projectKeyOrId")
                bs = [b for b in bs if pk in (b["location"]["projectKey"], str(b["location"]["projectId"]))]
            return 200, offset_page(bs, query, "values", 1), None
        m = re.fullmatch(r"/board/(\d+)/sprint", sub)
        if m:
            only(query, {"startAt", "maxResults", "state"})
            b = next((x for x in boards if x["id"] == int(m.group(1))), None)
            if b is None:
                raise jira_error(404, "Board does not exist or you do not have permission to see it.")
            if b["type"] != "scrum":
                raise jira_error(400, "The board does not support sprints")
            ss = F.SPRINTS.get(b["id"], [])
            if one(query, "state"):
                states = one(query, "state").split(",")
                bad = [s for s in states if s not in ("future", "active", "closed")]
                if bad:
                    raise jira_error(400, f"Invalid sprint state: {bad[0]}")
                ss = [s for s in ss if s["state"] in states]
            return 200, offset_page(ss, query, "values", 2), None
        raise jira_error(404, f"No agile route {sub}")

    # ---------------------------------------------------------- Confluence

    def confluence(self, sub: str, query: dict, wiki_base: str):
        v2 = sub.startswith("/api/v2")
        err = lambda s, m: wiki_error(s, m, v2)  # noqa: E731
        prefix = wiki_base[wiki_base.index("/", 8) :]  # path part of the wiki base, e.g. /cloud/wiki
        if sub == "/api/v2/spaces":
            only(query, {"ids", "keys", "type", "status", "labels", "sort", "description-format", "include-icon", "cursor", "limit"}, err)
            ss = F.SPACES
            if one(query, "keys"):
                keys = one(query, "keys").split(",")
                ss = [s for s in ss if s["key"] in keys]
            if one(query, "type"):
                ss = [s for s in ss if s["type"] == one(query, "type")]
            if one(query, "status"):
                ss = [s for s in ss if s["status"] == one(query, "status")]
            page = cursor_page(ss, query, 2, "/wiki/api/v2/spaces", True)
            page["_links"]["base"] = wiki_base
            return 200, page, None
        if sub == "/rest/api/search":
            only(query, {"cql", "cqlcontext", "cursor", "limit", "start", "includeArchivedSpaces", "excerpt", "expand"}, err)
            cql = one(query, "cql")
            if not cql:
                raise err(400, "cql is a required parameter")
            expand = [e for e in (one(query, "expand") or "").split(",") if e]
            for e in expand:
                if e not in CONTENT_EXPANDS:
                    raise err(400, f"Unsupported expansion '{e}'")
            try:
                expr, order = ql.parse(cql)
                hits = [p for p in F.PAGES if ql.evaluate(expr, p, cql_resolve, None, NOW)]
            except ql.QLError as e:
                raise err(400, f"Could not parse cql : {cql} ({e})") from None
            for fld, desc in reversed(order):
                if fld.lower() == "id":
                    hits.sort(key=lambda p: int(p["id"]), reverse=desc)
                elif fld.lower() in ("title", "created", "lastmodified"):
                    hits.sort(key=lambda p, f=fld.lower(): str(cql_resolve(p, f)[0]), reverse=desc)
                else:
                    raise err(400, f"Cannot order by {fld}")
            results = [search_result(p, expand, wiki_base) for p in hits]
            # v1 links are relative to _links.base (…/wiki); v2 links start with /wiki/ (relative
            # to the base's parent), as on a real site.
            page = cursor_page(results, query, 3, "/rest/api/search", False)
            page.update({"start": 0, "limit": 3, "size": len(page["results"]), "totalSize": len(results), "cqlQuery": cql})
            page["_links"].update({"base": wiki_base, "context": prefix})
            return 200, page, None
        m = re.fullmatch(r"/api/v2/pages/(\d+)/(versions|labels|footer-comments|inline-comments)", sub)
        if m:
            pid, what = m.group(1), m.group(2)
            if pid not in {p["id"] for p in F.PAGES}:
                raise err(404, f"Page {pid} not found")
            if what == "versions":
                only(query, {"cursor", "limit", "sort", "body-format"}, err)
                items = F.PAGE_VERSIONS.get(pid, [])
                cap = 2
            elif what == "labels":
                only(query, {"prefix", "sort", "cursor", "limit"}, err)
                p = next(x for x in F.PAGES if x["id"] == pid)
                items = [{"id": x["id"], "name": x["name"], "prefix": x["prefix"]} for x in p["metadata"]["labels"]["results"]]
                cap = 25
            else:
                only(query, {"body-format", "status", "resolution-status", "sort", "cursor", "limit"}, err)
                src = F.FOOTER_COMMENTS if what == "footer-comments" else F.INLINE_COMMENTS
                fmt = one(query, "body-format")
                if fmt not in (None, "storage", "atlas_doc_format"):
                    raise err(400, f"Invalid body-format {fmt}")
                items = [dict(c) if fmt == "storage" else {k: v for k, v in c.items() if k != "body"} for c in src.get(pid, [])]
                cap = 25
            page = cursor_page(items, query, cap, f"/wiki/api/v2/pages/{pid}/{what}", True)
            page["_links"]["base"] = wiki_base
            return 200, page, None
        raise err(404, f"No route {sub}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"PORT:{srv.server_address[1]}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
