"""Hand-built Atlassian fixture data in the documented REST response shapes.

Two Jira sites share one replay server:

* ``/cloud`` — Jira Cloud (REST v3, ADF rich text, accountIds, enhanced search) plus
  Confluence Cloud under ``/cloud/wiki``.
* ``/dc`` — Jira Data Center (REST v2, wiki-markup strings, usernames, classic
  search, sprint values as ``…Sprint@x[id=…]`` strings).

Shapes follow https://developer.atlassian.com/cloud/jira/platform/rest/v3/ ,
https://developer.atlassian.com/server/jira/platform/rest/ and
https://developer.atlassian.com/cloud/confluence/rest/v2/ .
"""

from __future__ import annotations


def adf(*paras: list) -> dict:
    """An ADF doc: each para is a list of inline nodes or plain strings."""
    content = []
    for p in paras:
        if isinstance(p, dict):
            content.append(p)
            continue
        nodes = [{"type": "text", "text": x} if isinstance(x, str) else x for x in p]
        content.append({"type": "paragraph", "content": nodes})
    return {"type": "doc", "version": 1, "content": content}


def mention(acc: str, text: str) -> dict:
    return {"type": "mention", "attrs": {"id": acc, "text": text}}


def bullets(*items: str) -> dict:
    return {
        "type": "bulletList",
        "content": [
            {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": i}]}]}
            for i in items
        ],
    }


# ------------------------------------------------------------------------- users

USERS = {
    "acc-ada": {
        "accountId": "acc-ada",
        "accountType": "atlassian",
        "displayName": "Ada Lovelace",
        "emailAddress": "ada@example.com",
        "active": True,
        "timeZone": "Europe/London",
        "locale": "en_GB",
    },
    # Grace's email is hidden by her profile visibility settings: the field is absent.
    "acc-grace": {
        "accountId": "acc-grace",
        "accountType": "atlassian",
        "displayName": "Grace Hopper",
        "active": True,
        "timeZone": "America/New_York",
        "locale": "en_US",
    },
    "acc-linus": {
        "accountId": "acc-linus",
        "accountType": "atlassian",
        "displayName": "Linus Torvalds",
        "active": False,
        "timeZone": "America/Los_Angeles",
        "locale": "en_US",
    },
    "acc-bot": {"accountId": "acc-bot", "accountType": "app", "displayName": "Automation for Jira", "active": True},
}


def user_ref(acc: str | None) -> dict | None:
    if acc is None:
        return None
    u = USERS[acc]
    return {k: u[k] for k in ("accountId", "accountType", "displayName", "active") if k in u}


# ------------------------------------------------------------------ site metadata

STATUS_CATEGORIES = {
    "new": {"id": 2, "key": "new", "name": "To Do", "colorName": "blue-gray"},
    "indeterminate": {"id": 4, "key": "indeterminate", "name": "In Progress", "colorName": "yellow"},
    "done": {"id": 3, "key": "done", "name": "Done", "colorName": "green"},
}
STATUSES = {
    "To Do": {"id": "10000", "name": "To Do", "description": "", "statusCategory": STATUS_CATEGORIES["new"]},
    "In Progress": {
        "id": "3",
        "name": "In Progress",
        "description": "Work has started",
        "statusCategory": STATUS_CATEGORIES["indeterminate"],
    },
    "In Review": {
        "id": "10100",
        "name": "In Review",
        "description": "Awaiting review",
        "statusCategory": STATUS_CATEGORIES["indeterminate"],
    },
    "Done": {"id": "10001", "name": "Done", "description": "", "statusCategory": STATUS_CATEGORIES["done"]},
}
ISSUE_TYPES = {
    "Epic": {"id": "10000", "name": "Epic", "description": "A big user story", "subtask": False, "hierarchyLevel": 1},
    "Story": {"id": "10001", "name": "Story", "description": "Functionality", "subtask": False, "hierarchyLevel": 0},
    "Bug": {"id": "10002", "name": "Bug", "description": "A problem", "subtask": False, "hierarchyLevel": 0},
    "Task": {"id": "10003", "name": "Task", "description": "A task", "subtask": False, "hierarchyLevel": 0},
    "Sub-task": {"id": "10004", "name": "Sub-task", "description": "Part of a task", "subtask": True, "hierarchyLevel": -1},
}
PRIORITIES = [
    {"id": "1", "name": "Highest", "description": "Blocks work", "statusColor": "#d04437", "iconUrl": "https://acme.example/p/1.svg"},
    {"id": "2", "name": "High", "description": "Serious", "statusColor": "#f15C75", "iconUrl": "https://acme.example/p/2.svg"},
    {"id": "3", "name": "Medium", "description": "Default", "statusColor": "#f79232", "iconUrl": "https://acme.example/p/3.svg"},
    {"id": "4", "name": "Low", "description": "Minor", "statusColor": "#707070", "iconUrl": "https://acme.example/p/4.svg"},
    {"id": "5", "name": "Lowest", "description": "Trivial", "statusColor": "#999999", "iconUrl": "https://acme.example/p/5.svg"},
]
PRIO = {p["name"]: p for p in PRIORITIES}
RESOLUTIONS = {
    "Done": {"id": "10000", "name": "Done", "description": "Work done"},
    "Won't Do": {"id": "10001", "name": "Won't Do", "description": "Not doing it"},
}


def sysfield(fid: str, name: str, typ: str, items: str | None = None, clause: list[str] | None = None) -> dict:
    schema = {"type": typ, "system": fid}
    if items:
        schema["items"] = items
    return {
        "id": fid,
        "key": fid,
        "name": name,
        "custom": False,
        "orderable": True,
        "navigable": True,
        "searchable": True,
        "clauseNames": clause or [fid],
        "schema": schema,
    }


def customfield(num: int, name: str, typ: str, custom: str, items: str | None = None) -> dict:
    schema = {"type": typ, "custom": custom, "customId": num}
    if items:
        schema["items"] = items
    return {
        "id": f"customfield_{num}",
        "key": f"customfield_{num}",
        "name": name,
        "custom": True,
        "orderable": True,
        "navigable": True,
        "searchable": True,
        "clauseNames": [f"cf[{num}]", name],
        "schema": schema,
    }


SYSTEM_FIELDS = [
    sysfield("summary", "Summary", "string"),
    sysfield("status", "Status", "status"),
    sysfield("issuetype", "Issue Type", "issuetype", clause=["issuetype", "type"]),
    sysfield("project", "Project", "project"),
    sysfield("priority", "Priority", "priority"),
    sysfield("resolution", "Resolution", "resolution"),
    sysfield("assignee", "Assignee", "user"),
    sysfield("reporter", "Reporter", "user"),
    sysfield("creator", "Creator", "user"),
    sysfield("labels", "Labels", "array", "string"),
    sysfield("components", "Components", "array", "component", ["component"]),
    sysfield("fixVersions", "Fix versions", "array", "version", ["fixVersion"]),
    sysfield("versions", "Affects versions", "array", "version", ["affectedVersion"]),
    sysfield("parent", "Parent", "issuelink"),
    sysfield("duedate", "Due date", "date", clause=["due", "duedate"]),
    sysfield("timeoriginalestimate", "Original estimate", "number"),
    sysfield("timeestimate", "Remaining Estimate", "number"),
    sysfield("timespent", "Time Spent", "number"),
    sysfield("votes", "Votes", "votes"),
    sysfield("watches", "Watchers", "watches"),
    sysfield("description", "Description", "string"),
    sysfield("created", "Created", "datetime"),
    sysfield("updated", "Updated", "datetime"),
    sysfield("resolutiondate", "Resolved", "datetime", clause=["resolved", "resolutiondate"]),
    sysfield("statuscategorychangedate", "Status Category Changed", "datetime"),
    sysfield("issuelinks", "Linked Issues", "array", "issuelinks"),
    sysfield("comment", "Comment", "comments-page"),
    sysfield("worklog", "Log Work", "array", "worklog"),
]
CLOUD_CUSTOM = [
    customfield(10016, "Story point estimate", "number", "com.atlassian.jira.plugin.system.customfieldtypes:float"),
    customfield(10020, "Sprint", "array", "com.pyxis.greenhopper.jira:gh-sprint", "json"),
    customfield(10030, "Team", "option", "com.atlassian.jira.plugin.system.customfieldtypes:select"),
    customfield(10040, "Customer Tier", "string", "com.atlassian.jira.plugin.system.customfieldtypes:textfield"),
]
DC_CUSTOM = [
    customfield(10100, "Sprint", "array", "com.pyxis.greenhopper.jira:gh-sprint", "string"),
    customfield(10101, "Story Points", "number", "com.atlassian.jira.plugin.system.customfieldtypes:float"),
]

# ------------------------------------------------------------------- projects

CLOUD_PROJECTS = [
    {
        "id": "10000",
        "key": "ENG",
        "name": "Engineering",
        "projectTypeKey": "software",
        "style": "classic",
        "isPrivate": False,
        "simplified": False,
        "projectCategory": {"id": "10000", "name": "Product"},
        "description": "Product engineering",
        "lead": user_ref("acc-ada"),
    },
    {
        "id": "10001",
        "key": "OPS",
        "name": "Operations",
        "projectTypeKey": "business",
        "style": "next-gen",
        "isPrivate": True,
        "simplified": True,
        "description": "Ops and IT",
        "lead": user_ref("acc-grace"),
    },
]
COMPONENTS = {
    "ENG": [
        {"id": "10100", "name": "Backend", "description": "APIs and indexing", "lead": user_ref("acc-ada"), "assigneeType": "COMPONENT_LEAD"},
        {"id": "10101", "name": "Frontend", "description": "Web UI", "lead": user_ref("acc-grace"), "assigneeType": "PROJECT_DEFAULT"},
    ],
    "OPS": [],
}
VERSIONS = {
    "ENG": [
        {"id": "10200", "name": "0.9", "description": "Beta", "archived": False, "released": True, "overdue": False, "startDate": "2026-06-01", "releaseDate": "2026-08-01", "projectId": 10000},
        {"id": "10201", "name": "1.0", "description": "GA", "archived": False, "released": False, "overdue": False, "startDate": "2026-08-02", "releaseDate": "2026-12-01", "projectId": 10000},
    ],
    "OPS": [],
}
PROJECT_TYPES = {"ENG": ["Epic", "Story", "Bug", "Task", "Sub-task"], "OPS": ["Task"]}
WORKFLOW = {
    "Epic": ["To Do", "In Progress", "Done"],
    "Story": ["To Do", "In Progress", "In Review", "Done"],
    "Bug": ["To Do", "In Progress", "In Review", "Done"],
    "Task": ["To Do", "In Progress", "Done"],
    "Sub-task": ["To Do", "In Progress", "Done"],
}

BOARDS = [
    {"id": 1, "name": "ENG Scrum", "type": "scrum", "location": {"projectId": 10000, "projectKey": "ENG", "projectName": "Engineering", "displayName": "Engineering (ENG)"}},
    {"id": 2, "name": "OPS Kanban", "type": "kanban", "location": {"projectId": 10001, "projectKey": "OPS", "projectName": "Operations", "displayName": "Operations (OPS)"}},
]
SPRINTS = {
    1: [
        {"id": 1, "state": "closed", "name": "ENG Sprint 1", "startDate": "2026-09-14T09:00:00.000Z", "endDate": "2026-09-28T09:00:00.000Z", "completeDate": "2026-09-28T10:00:00.000Z", "createdDate": "2026-09-10T09:00:00.000Z", "originBoardId": 1, "goal": "Index MVP"},
        {"id": 2, "state": "active", "name": "ENG Sprint 2", "startDate": "2026-11-02T09:00:00.000Z", "endDate": "2026-11-16T09:00:00.000Z", "createdDate": "2026-10-28T09:00:00.000Z", "originBoardId": 1, "goal": "Ship search"},
        {"id": 3, "state": "future", "name": "ENG Sprint 3", "createdDate": "2026-11-01T09:00:00.000Z", "originBoardId": 1, "goal": ""},
    ]
}
SPRINT_BY_ID = {s["id"]: dict(s, boardId=b) for b, ss in SPRINTS.items() for s in ss}


def version_ref(project: str, name: str) -> dict:
    v = next(x for x in VERSIONS[project] if x["name"] == name)
    return {"id": v["id"], "name": v["name"], "archived": v["archived"], "released": v["released"]}


def component_ref(project: str, name: str) -> dict:
    c = next(x for x in COMPONENTS[project] if x["name"] == name)
    return {"id": c["id"], "name": c["name"]}


# ---------------------------------------------------------------------- issues


def issue(
    num_id: int,
    key: str,
    summary: str,
    itype: str,
    status: str,
    *,
    created: str,
    updated: str,
    reporter: str = "acc-grace",
    assignee: str | None = None,
    priority: str = "Medium",
    resolution: str | None = None,
    resolved: str | None = None,
    labels: list[str] | None = None,
    components: list[str] = (),
    fix: list[str] = (),
    affects: list[str] = (),
    parent: str | None = None,
    sprints: list[int] = (),
    points: float | None = None,
    team: str | None = None,
    tier: str | None = None,
    description: dict | None = None,
    duedate: str | None = None,
    estimate: int | None = None,
    spent: int | None = None,
    votes: int = 0,
    watches: int = 1,
) -> dict:
    project = next(p for p in CLOUD_PROJECTS if key.startswith(p["key"] + "-"))
    fields = {
        "summary": summary,
        "status": dict(STATUSES[status]),
        "issuetype": dict(ISSUE_TYPES[itype]),
        "project": {"id": project["id"], "key": project["key"], "name": project["name"], "projectTypeKey": project["projectTypeKey"]},
        "priority": {"id": PRIO[priority]["id"], "name": priority},
        "resolution": RESOLUTIONS[resolution] if resolution else None,
        "assignee": user_ref(assignee),
        "reporter": user_ref(reporter),
        "creator": user_ref(reporter),
        "labels": labels or [],
        "components": [component_ref(project["key"], c) for c in components],
        "fixVersions": [version_ref(project["key"], v) for v in fix],
        "versions": [version_ref(project["key"], v) for v in affects],
        "duedate": duedate,
        "timeoriginalestimate": estimate,
        "timeestimate": estimate - (spent or 0) if estimate else None,
        "timespent": spent,
        "votes": {"votes": votes, "hasVoted": False},
        "watches": {"watchCount": watches, "isWatching": False},
        "description": description,
        "created": created,
        "updated": updated,
        "resolutiondate": resolved,
        "statuscategorychangedate": updated,
        "issuelinks": [],
        "customfield_10016": points,
        "customfield_10020": [dict(SPRINT_BY_ID[s]) for s in sprints] or None,
        "customfield_10030": {"id": f"opt-{team}", "value": team} if team else None,
        "customfield_10040": tier,
    }
    if parent:
        fields["parent"] = {"id": "", "key": parent}
    return {"id": str(num_id), "key": key, "fields": fields}


CLOUD_ISSUES = [
    issue(10001, "ENG-1", "Search revamp", "Epic", "In Progress", created="2026-09-01T09:00:00.000+0000",
          updated="2026-11-03T12:00:00.000+0000", assignee="acc-ada", priority="High", labels=["search"],
          description=adf(["Replace the legacy search with ", {"type": "text", "text": "Elastic", "marks": [{"type": "strong"}]}, "."],
                          bullets("indexing", "query UI"))),
    issue(10002, "ENG-2", "Index documents", "Story", "Done", created="2026-09-10T09:00:00.000+0000",
          updated="2026-10-10T16:30:00.000+0000", assignee="acc-ada", priority="High", resolution="Done",
          resolved="2026-10-10T16:30:00.000+0000", labels=["backend", "search"], components=["Backend"],
          fix=["1.0"], parent="ENG-1", sprints=[1, 2], points=5, estimate=43200, spent=36000, votes=2, watches=3,
          description=adf(["Index every document type."])),
    issue(10003, "ENG-3", "Crash on empty query", "Bug", "In Review", created="2026-10-02T08:15:00.000+0000",
          updated="2026-11-04T10:00:00.000+0000", reporter="acc-ada", assignee="acc-grace", priority="Highest",
          labels=["backend"], components=["Backend"], affects=["0.9"], sprints=[2], points=3, spent=3600,
          duedate="2026-11-20", description=adf(["Steps: search for ", mention("acc-ada", "@Ada Lovelace"), " with nothing."])),
    issue(10004, "ENG-4", "Search UI", "Story", "To Do", created="2026-10-05T11:00:00.000+0000",
          updated="2026-10-05T11:00:00.000+0000", labels=["frontend"], components=["Frontend"], parent="ENG-1",
          sprints=[3], points=8, priority="Medium"),
    issue(10005, "ENG-5", 'Typo in "Settings" page', "Bug", "Done", created="2026-10-20T14:00:00.000+0000",
          updated="2026-10-21T09:00:00.000+0000", assignee="acc-linus", priority="Low", resolution="Won't Do",
          resolved="2026-10-21T09:00:00.000+0000"),
    issue(10006, "ENG-6", "Add regression test", "Sub-task", "In Progress", created="2026-11-04T10:30:00.000+0000",
          updated="2026-11-05T10:30:00.000+0000", assignee="acc-ada", parent="ENG-3", sprints=[2], priority="Medium"),
    issue(10007, "ENG-7", "Upgrade dependencies", "Task", "To Do", created="2026-11-05T15:00:00.000+0000",
          updated="2026-11-05T15:00:00.000+0000", assignee="acc-grace", labels=["backend", "chore"], priority="Medium"),
    issue(10101, "OPS-1", "Rotate certificates", "Task", "Done", created="2026-08-15T09:00:00.000+0000",
          updated="2026-08-20T17:00:00.000+0000", assignee="acc-grace", resolution="Done",
          resolved="2026-08-20T17:00:00.000+0000", team="SRE", tier="Gold"),
    issue(10102, "OPS-2", "Investigate 'disk full' alerts", "Task", "In Progress", created="2026-11-01T07:00:00.000+0000",
          updated="2026-11-06T08:00:00.000+0000", reporter="acc-bot", assignee="acc-ada", labels=["incident"], team="SRE",
          priority="High"),
    issue(10103, "OPS-3", "Onboard new hire", "Task", "To Do", created="2026-11-07T09:00:00.000+0000",
          updated="2026-11-07T09:00:00.000+0000", team="IT", tier="Silver"),
]
CLOUD_BY_KEY = {i["key"]: i for i in CLOUD_ISSUES}
for _i in CLOUD_ISSUES:
    _p = _i["fields"].get("parent")
    if _p:
        _pi = CLOUD_BY_KEY[_p["key"]]
        _p.update({"id": _pi["id"], "fields": {"summary": _pi["fields"]["summary"], "status": _pi["fields"]["status"]}})


def link_ref(key: str) -> dict:
    f = CLOUD_BY_KEY[key]["fields"]
    return {"id": CLOUD_BY_KEY[key]["id"], "key": key, "fields": {"summary": f["summary"], "status": f["status"], "priority": f["priority"], "issuetype": f["issuetype"]}}


BLOCKS = {"id": "10000", "name": "Blocks", "inward": "is blocked by", "outward": "blocks"}
RELATES = {"id": "10003", "name": "Relates", "inward": "relates to", "outward": "relates to"}
CLOUD_BY_KEY["ENG-3"]["fields"]["issuelinks"] = [{"id": "20001", "type": BLOCKS, "outwardIssue": link_ref("ENG-4")}]
CLOUD_BY_KEY["ENG-4"]["fields"]["issuelinks"] = [{"id": "20001", "type": BLOCKS, "inwardIssue": link_ref("ENG-3")}]
CLOUD_BY_KEY["ENG-5"]["fields"]["issuelinks"] = [{"id": "20002", "type": RELATES, "outwardIssue": link_ref("OPS-2")}]
CLOUD_BY_KEY["OPS-2"]["fields"]["issuelinks"] = [{"id": "20002", "type": RELATES, "inwardIssue": link_ref("ENG-5")}]


def status_change(hid: str, who: str, at: str, frm: str, to: str) -> dict:
    return {
        "id": hid,
        "author": user_ref(who),
        "created": at,
        "items": [
            {"field": "status", "fieldtype": "jira", "fieldId": "status", "from": STATUSES[frm]["id"], "fromString": frm, "to": STATUSES[to]["id"], "toString": to}
        ],
    }


CHANGELOG = {
    "ENG-1": [status_change("30001", "acc-ada", "2026-09-15T09:00:00.000+0000", "To Do", "In Progress")],
    "ENG-2": [
        {
            "id": "30010",
            "author": user_ref("acc-grace"),
            "created": "2026-09-12T10:00:00.000+0000",
            "items": [
                {"field": "assignee", "fieldtype": "jira", "fieldId": "assignee", "from": None, "fromString": None, "to": "acc-ada", "toString": "Ada Lovelace"},
                {"field": "Sprint", "fieldtype": "custom", "fieldId": "customfield_10020", "from": "", "fromString": "", "to": "1", "toString": "ENG Sprint 1"},
            ],
        },
        status_change("30011", "acc-ada", "2026-09-15T09:00:00.000+0000", "To Do", "In Progress"),
        status_change("30012", "acc-ada", "2026-10-01T12:00:00.000+0000", "In Progress", "In Review"),
        status_change("30013", "acc-grace", "2026-10-03T12:00:00.000+0000", "In Review", "In Progress"),
        status_change("30014", "acc-ada", "2026-10-08T12:00:00.000+0000", "In Progress", "In Review"),
        status_change("30015", "acc-grace", "2026-10-10T16:30:00.000+0000", "In Review", "Done"),
    ],
    "ENG-3": [
        status_change("30020", "acc-grace", "2026-10-03T09:00:00.000+0000", "To Do", "In Progress"),
        status_change("30021", "acc-grace", "2026-11-04T10:00:00.000+0000", "In Progress", "In Review"),
    ],
    "ENG-5": [status_change("30030", "acc-linus", "2026-10-21T09:00:00.000+0000", "To Do", "Done")],
    "OPS-1": [
        status_change("30040", "acc-grace", "2026-08-16T09:00:00.000+0000", "To Do", "In Progress"),
        status_change("30041", "acc-grace", "2026-08-20T17:00:00.000+0000", "In Progress", "Done"),
    ],
}

COMMENTS = {
    "ENG-1": [
        {"id": "40001", "author": user_ref("acc-grace"), "body": adf(["Kick-off notes attached. ", mention("acc-ada", "@Ada Lovelace"), " please review."]), "created": "2026-09-02T10:00:00.000+0000", "updated": "2026-09-02T10:00:00.000+0000", "jsdPublic": True},
        {"id": "40002", "author": user_ref("acc-ada"), "body": adf(["Looks good."], {"type": "codeBlock", "content": [{"type": "text", "text": "GET /search?q="}]}), "created": "2026-09-03T08:00:00.000+0000", "updated": "2026-09-04T08:00:00.000+0000", "jsdPublic": True},
    ],
    "ENG-3": [
        {"id": "40010", "author": user_ref("acc-ada"), "body": adf(["Stack trace in the attachment."]), "created": "2026-10-02T09:00:00.000+0000", "updated": "2026-10-02T09:00:00.000+0000", "visibility": {"type": "role", "value": "Developers", "identifier": "Developers"}, "jsdPublic": True},
    ],
    "OPS-2": [
        {"id": "40020", "author": user_ref("acc-bot"), "body": adf(["Alert fired on host db-1."]), "created": "2026-11-01T07:00:05.000+0000", "updated": "2026-11-01T07:00:05.000+0000", "jsdPublic": False},
    ],
}

WORKLOGS = {
    "ENG-2": [
        {"id": "50001", "author": user_ref("acc-ada"), "comment": adf(["Schema design"]), "started": "2026-09-16T09:00:00.000+0000", "timeSpent": "3h", "timeSpentSeconds": 10800, "created": "2026-09-16T12:00:00.000+0000", "updated": "2026-09-16T12:00:00.000+0000", "issueId": "10002"},
        {"id": "50002", "author": user_ref("acc-grace"), "comment": adf(["Review + fixes"]), "started": "2026-10-02T09:00:00.000+0000", "timeSpent": "7h", "timeSpentSeconds": 25200, "created": "2026-10-02T17:00:00.000+0000", "updated": "2026-10-02T17:00:00.000+0000", "issueId": "10002"},
    ],
    "ENG-3": [
        {"id": "50010", "author": user_ref("acc-grace"), "started": "2026-10-03T09:00:00.000+0000", "timeSpent": "1h", "timeSpentSeconds": 3600, "created": "2026-10-03T10:00:00.000+0000", "updated": "2026-10-03T10:00:00.000+0000", "issueId": "10003"},
    ],
}

# ------------------------------------------------------------------ Data Center

DC_USERS = {
    "jsmith": {"key": "JIRAUSER10000", "name": "jsmith", "displayName": "John Smith", "emailAddress": "jsmith@corp.example", "active": True, "timeZone": "Europe/Berlin", "locale": "de_DE"},
    "mjones": {"key": "JIRAUSER10001", "name": "mjones", "displayName": "Mary Jones", "emailAddress": "mjones@corp.example", "active": True, "timeZone": "Europe/Berlin", "locale": "en_US"},
}


def dc_user(name: str | None) -> dict | None:
    if name is None:
        return None
    u = DC_USERS[name]
    return {k: u[k] for k in ("key", "name", "displayName", "emailAddress", "active")}


DC_PROJECTS = [
    {"id": "10200", "key": "LEG", "name": "Legacy", "projectTypeKey": "software", "description": "The old monolith", "lead": dc_user("jsmith"), "projectCategory": {"id": "1", "name": "Maintenance"}},
]
DC_SPRINT = "com.atlassian.greenhopper.service.sprint.Sprint@3f1c2a[id=7,rapidViewId=5,state=ACTIVE,name=LEG Sprint 7,startDate=2026-11-01T09:00:00.000+01:00,endDate=2026-11-15T09:00:00.000+01:00,completeDate=<null>,sequence=7,goal=]"


def dc_issue(num_id: int, key: str, summary: str, itype: str, status: str, *, created: str, updated: str, reporter: str,
             assignee: str | None, labels: list[str], description: str | None, sprint: bool = False,
             points: float | None = None, resolution: str | None = None, resolved: str | None = None) -> dict:
    p = DC_PROJECTS[0]
    return {
        "id": str(num_id),
        "key": key,
        "fields": {
            "summary": summary,
            "status": dict(STATUSES[status]),
            "issuetype": dict(ISSUE_TYPES[itype]),
            "project": {"id": p["id"], "key": p["key"], "name": p["name"]},
            "priority": {"id": "3", "name": "Medium"},
            "resolution": RESOLUTIONS[resolution] if resolution else None,
            "assignee": dc_user(assignee),
            "reporter": dc_user(reporter),
            "creator": dc_user(reporter),
            "labels": labels,
            "components": [],
            "fixVersions": [],
            "versions": [],
            "description": description,
            "created": created,
            "updated": updated,
            "resolutiondate": resolved,
            "issuelinks": [],
            "customfield_10100": [DC_SPRINT] if sprint else None,
            "customfield_10101": points,
        },
    }


DC_ISSUES = [
    dc_issue(20001, "LEG-1", "Migrate cron jobs", "Task", "In Progress", created="2026-10-01T09:00:00.000+0200",
             updated="2026-11-02T09:00:00.000+0100", reporter="mjones", assignee="jsmith", labels=["infra"],
             description="h1. Plan\n* move to *k8s*", sprint=True, points=3),
    dc_issue(20002, "LEG-2", "Remove dead code", "Story", "Done", created="2026-09-01T09:00:00.000+0200",
             updated="2026-09-20T09:00:00.000+0200", reporter="jsmith", assignee="mjones", labels=[],
             description=None, resolution="Done", resolved="2026-09-20T09:00:00.000+0200"),
    dc_issue(20003, "LEG-3", "Login page 500s", "Bug", "To Do", created="2026-11-03T09:00:00.000+0100",
             updated="2026-11-03T09:00:00.000+0100", reporter="mjones", assignee=None, labels=["infra", "urgent"],
             description="Seen after the 9.12 upgrade."),
]
DC_CHANGELOG = {
    "LEG-1": [
        {"id": "900", "author": dc_user("jsmith"), "created": "2026-10-05T09:00:00.000+0200",
         "items": [{"field": "status", "fieldtype": "jira", "from": "10000", "fromString": "To Do", "to": "3", "toString": "In Progress"}]},
    ],
    "LEG-2": [
        {"id": "910", "author": dc_user("mjones"), "created": "2026-09-20T09:00:00.000+0200",
         "items": [{"field": "status", "fieldtype": "jira", "from": "10000", "fromString": "To Do", "to": "10001", "toString": "Done"},
                   {"field": "resolution", "fieldtype": "jira", "from": None, "fromString": None, "to": "10000", "toString": "Done"}]},
    ],
}
DC_COMMENTS = {
    "LEG-1": [{"id": "70001", "author": dc_user("mjones"), "body": "Please do the *batch* jobs first.", "created": "2026-10-02T09:00:00.000+0200", "updated": "2026-10-02T09:00:00.000+0200"}],
}

# ------------------------------------------------------------------- Confluence

SPACES = [
    {"id": "65537", "key": "ENG", "name": "Engineering", "type": "global", "status": "current", "authorId": "acc-ada", "createdAt": "2026-01-10T09:00:00.000Z", "homepageId": "1000", "_links": {"webui": "/spaces/ENG"}},
    {"id": "65538", "key": "OPS", "name": "Operations", "type": "global", "status": "current", "authorId": "acc-grace", "createdAt": "2026-01-11T09:00:00.000Z", "homepageId": "1010", "_links": {"webui": "/spaces/OPS"}},
    {"id": "65539", "key": "~ada", "name": "Ada Lovelace", "type": "personal", "status": "current", "authorId": "acc-ada", "createdAt": "2026-02-01T09:00:00.000Z", "homepageId": "1020", "_links": {"webui": "/spaces/~ada"}},
    {"id": "65540", "key": "OLD", "name": "Old wiki", "type": "global", "status": "archived", "authorId": "acc-linus", "createdAt": "2025-01-01T09:00:00.000Z", "homepageId": "1030", "_links": {"webui": "/spaces/OLD"}},
]


def page(pid: str, space: str, title: str, *, ptype: str = "page", labels: list[str] = (), body: str, author: str,
         created: str, modified: str, version: int, editor: str, ancestors: list[str] = ()) -> dict:
    return {
        "id": pid,
        "type": ptype,
        "status": "current",
        "title": title,
        "space": {"key": space, "name": next(s["name"] for s in SPACES if s["key"] == space)},
        "history": {"createdBy": {"accountId": author, "displayName": USERS[author]["displayName"]}, "createdDate": created},
        "version": {"number": version, "when": modified, "by": {"accountId": editor, "displayName": USERS[editor]["displayName"]}},
        "metadata": {"labels": {"results": [{"prefix": "global", "name": n, "id": f"l-{n}"} for n in labels]}},
        "ancestors": [{"id": a} for a in ancestors],
        "body": {"storage": {"value": body, "representation": "storage"}},
        "_links": {"webui": f"/spaces/{space}/pages/{pid}", "tinyui": f"/x/{pid}"},
    }


PAGES = [
    page("1000", "ENG", "Engineering Home", body="<p>Welcome to <strong>Engineering</strong>.</p>", author="acc-ada",
         created="2026-01-10T09:00:00.000Z", modified="2026-01-10T09:00:00.000Z", version=1, editor="acc-ada"),
    page("1001", "ENG", "Search architecture", labels=["architecture", "search"], ancestors=["1000"],
         body=(
             "<h1>Overview</h1><p>The indexer &amp; query API.</p>"
             "<ul><li>Indexer</li><li>Query &lt;API&gt;</li></ul>"
             "<table><tbody><tr><th>Part</th><th>Owner</th></tr><tr><td>Indexer</td><td>"
             '<ac:link><ri:user ri:account-id="acc-ada" /></ac:link></td></tr></tbody></table>'
             '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[GET /search]]></ac:plain-text-body></ac:structured-macro>'
         ),
         author="acc-ada", created="2026-09-05T09:00:00.000Z", modified="2026-10-15T14:00:00.000Z", version=3, editor="acc-grace"),
    page("1010", "OPS", "Operations Home", body="<p>Ops landing page.</p>", author="acc-grace",
         created="2026-01-11T09:00:00.000Z", modified="2026-01-11T09:00:00.000Z", version=1, editor="acc-grace"),
    page("1011", "OPS", "Runbook: Rotate certificates", labels=["runbook"], ancestors=["1010"],
         body="<p>Deploy the new cert with <code>certctl deploy</code>.</p>", author="acc-grace",
         created="2026-08-15T09:00:00.000Z", modified="2026-08-21T09:00:00.000Z", version=2, editor="acc-grace"),
    page("1012", "OPS", "Runbook: Disk full", labels=["runbook", "incident"], ancestors=["1010"],
         body="<p>Free space, then redeploy.</p>", author="acc-ada",
         created="2026-11-01T09:00:00.000Z", modified="2026-11-06T09:00:00.000Z", version=1, editor="acc-ada"),
    page("1013", "OPS", "Postmortem: October outage", ptype="blogpost", labels=["postmortem"],
         body="<p>What happened on 2026-10-12.</p>", author="acc-grace",
         created="2026-10-14T09:00:00.000Z", modified="2026-10-14T09:00:00.000Z", version=1, editor="acc-grace"),
]
PAGE_VERSIONS = {
    "1001": [
        {"number": 1, "message": "First draft", "minorEdit": False, "authorId": "acc-ada", "createdAt": "2026-09-05T09:00:00.000Z"},
        {"number": 2, "message": "", "minorEdit": True, "authorId": "acc-ada", "createdAt": "2026-09-06T09:00:00.000Z"},
        {"number": 3, "message": "Add owner table", "minorEdit": False, "authorId": "acc-grace", "createdAt": "2026-10-15T14:00:00.000Z"},
    ],
}
FOOTER_COMMENTS = {
    "1001": [
        {"id": "c-1", "status": "current", "title": "Re: Search architecture", "pageId": "1001",
         "version": {"number": 1, "authorId": "acc-grace", "createdAt": "2026-09-07T09:00:00.000Z"},
         "body": {"storage": {"value": "<p>Where does the <em>ranking</em> live?</p>", "representation": "storage"}}},
    ],
}
INLINE_COMMENTS = {
    "1001": [
        {"id": "c-2", "status": "current", "title": "Re: Search architecture", "pageId": "1001", "resolutionStatus": "open",
         "properties": {"inlineMarkerRef": "m-1", "inlineOriginalSelection": "query API"},
         "version": {"number": 1, "authorId": "acc-linus", "createdAt": "2026-09-08T09:00:00.000Z"},
         "body": {"storage": {"value": "<p>Is this REST or gRPC?</p>", "representation": "storage"}}},
        {"id": "c-3", "status": "current", "title": "Re: Search architecture", "pageId": "1001", "resolutionStatus": "resolved",
         "properties": {"inlineMarkerRef": "m-2", "inlineOriginalSelection": "Indexer"},
         "version": {"number": 1, "authorId": "acc-ada", "createdAt": "2026-09-09T09:00:00.000Z"},
         "body": {"storage": {"value": "<p>Renamed.</p>", "representation": "storage"}}},
    ],
}
