"""A small JQL / CQL parser and evaluator for the replay server (stdlib only).

It understands the subset the worker generates plus what the tests pass by hand:

* clauses ``field op value`` with ``= != > >= < <= ~ !~``, ``field [not] in (…)``,
  ``field is [not] EMPTY|NULL``; ``AND`` / ``OR`` / ``NOT`` and parentheses;
* values: double- or single-quoted strings with backslash escapes, bare words,
  numbers, and function calls (``subTaskIssueTypes()``, ``openSprints()`` …);
* a trailing ``ORDER BY field [ASC|DESC], …``.

Field names are resolved by the caller (``resolve(item, field) -> list | None``; None
means "unknown field", which is a 400 like Jira's). Anything else unparsable raises
``QLError`` — so a worker that emits bad quoting or unknown syntax gets a 400, and a
worker that pushes the wrong predicate gets the wrong rows.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from typing import Any, Callable


class QLError(ValueError):
    pass


KEYWORDS = {"and", "or", "not", "in", "is", "empty", "null", "order", "by", "asc", "desc"}
TOKEN = re.compile(
    r"""\s*(?:
      (?P<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
    | (?P<op>!=|>=|<=|!~|=|>|<|~)
    | (?P<punct>[(),])
    | (?P<word>[A-Za-z0-9_.\-\[\]:/@+*]+)
    )""",
    re.X,
)


@dataclass
class Tok:
    kind: str
    text: str


def tokenize(q: str) -> list[Tok]:
    out: list[Tok] = []
    pos = 0
    q = q.rstrip()
    while pos < len(q):
        m = TOKEN.match(q, pos)
        if not m or m.end() == pos:
            raise QLError(f"Error in the query: unexpected character at position {pos}: {q[pos:pos + 10]!r}")
        pos = m.end()
        if m.group("str") is not None:
            raw = m.group("str")[1:-1]
            text = re.sub(r"\\(.)", lambda e: {"n": "\n", "t": "\t", "r": "\r"}.get(e.group(1), e.group(1)), raw)
            out.append(Tok("str", text))
        elif m.group("op") is not None:
            out.append(Tok("op", m.group("op")))
        elif m.group("punct") is not None:
            out.append(Tok(m.group("punct"), m.group("punct")))
        else:
            w = m.group("word")
            out.append(Tok("kw" if w.lower() in KEYWORDS else "word", w))
    return out


@dataclass
class Value:
    text: str
    quoted: bool = False
    func: str | None = None


@dataclass
class Clause:
    field: str
    op: str  # = != > >= < <= ~ !~ in notin is isnot
    values: list[Value]


@dataclass
class Bool:
    op: str  # and / or / not
    children: list[Any]


class Parser:
    def __init__(self, q: str):
        self.toks = tokenize(q)
        self.i = 0

    def peek(self, k: int = 0) -> Tok | None:
        return self.toks[self.i + k] if self.i + k < len(self.toks) else None

    def kw(self, word: str) -> bool:
        t = self.peek()
        return t is not None and t.kind == "kw" and t.text.lower() == word

    def take(self) -> Tok:
        t = self.peek()
        if t is None:
            raise QLError("Error in the query: unexpected end of query")
        self.i += 1
        return t

    def parse(self) -> tuple[Any, list[tuple[str, bool]]]:
        expr = None
        if not self.kw("order"):
            expr = self.or_expr()
        order: list[tuple[str, bool]] = []
        if self.kw("order"):
            self.take()
            if not self.kw("by"):
                raise QLError("Error in the query: expecting 'by' after 'order'")
            self.take()
            while True:
                f = self.take()
                if f.kind not in ("word", "str"):
                    raise QLError(f"Error in the query: expecting a field name, got {f.text!r}")
                desc = False
                if self.kw("asc") or self.kw("desc"):
                    desc = self.take().text.lower() == "desc"
                order.append((f.text, desc))
                if self.peek() and self.peek().kind == ",":
                    self.take()
                    continue
                break
        if self.peek() is not None:
            raise QLError(f"Error in the query: unexpected {self.peek().text!r}")
        return expr, order

    def or_expr(self):
        kids = [self.and_expr()]
        while self.kw("or"):
            self.take()
            kids.append(self.and_expr())
        return kids[0] if len(kids) == 1 else Bool("or", kids)

    def and_expr(self):
        kids = [self.not_expr()]
        while self.kw("and"):
            self.take()
            kids.append(self.not_expr())
        return kids[0] if len(kids) == 1 else Bool("and", kids)

    def not_expr(self):
        if self.kw("not"):
            self.take()
            return Bool("not", [self.not_expr()])
        t = self.peek()
        if t is not None and t.kind == "(":
            self.take()
            e = self.or_expr()
            if not self.peek() or self.take().kind != ")":
                raise QLError("Error in the query: missing ')'")
            return e
        return self.clause()

    def value(self) -> Value:
        t = self.take()
        if t.kind == "str":
            return Value(t.text, quoted=True)
        if t.kind == "word":
            nxt = self.peek()
            if nxt is not None and nxt.kind == "(":
                self.take()
                if not self.peek() or self.take().kind != ")":
                    raise QLError(f"Error in the query: function {t.text} takes no arguments here")
                return Value(t.text, func=t.text.lower())
            return Value(t.text)
        if t.kind == "kw" and t.text.lower() in ("empty", "null"):
            return Value("EMPTY")
        raise QLError(f"Error in the query: expecting a value, got {t.text!r}")

    def clause(self) -> Clause:
        f = self.take()
        if f.kind not in ("word", "str"):
            raise QLError(f"Error in the query: expecting a field name, got {f.text!r}")
        field = f.text
        if self.kw("is"):
            self.take()
            neg = False
            if self.kw("not"):
                self.take()
                neg = True
            if not (self.kw("empty") or self.kw("null")):
                raise QLError("Error in the query: expecting EMPTY or NULL after IS")
            self.take()
            return Clause(field, "isnot" if neg else "is", [])
        neg = False
        if self.kw("not"):
            self.take()
            neg = True
            if not self.kw("in"):
                raise QLError("Error in the query: expecting 'in' after 'not'")
        if self.kw("in"):
            self.take()
            t = self.peek()
            if t is not None and t.kind == "word" and self.peek(1) is not None and self.peek(1).kind == "(":
                return Clause(field, "notin" if neg else "in", [self.value()])
            if not t or self.take().kind != "(":
                raise QLError("Error in the query: expecting '(' after IN")
            vals = [self.value()]
            while self.peek() is not None and self.peek().kind == ",":
                self.take()
                vals.append(self.value())
            if not self.peek() or self.take().kind != ")":
                raise QLError("Error in the query: expecting ')' to close IN list")
            return Clause(field, "notin" if neg else "in", vals)
        op = self.take()
        if op.kind != "op":
            raise QLError(f"Error in the query: expecting an operator after {field!r}, got {op.text!r}")
        return Clause(field, op.text, [self.value()])


def parse(q: str):
    return Parser(q).parse()


# ----------------------------------------------------------------------- evaluation

DATE_FORMATS = ["%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M", "%Y-%m-%d", "%Y/%m/%d"]


def parse_date(text: str, now: dt.datetime) -> dt.datetime | None:
    m = re.fullmatch(r"([-+]?)(\d+)([dwhm])", text.strip())
    if m:
        n = int(m.group(2)) * (-1 if m.group(1) == "-" else 1)
        unit = {"d": "days", "w": "weeks", "h": "hours", "m": "minutes"}[m.group(3)]
        return now + dt.timedelta(**{unit: n})
    for f in DATE_FORMATS:
        try:
            return dt.datetime.strptime(text.strip(), f).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
    return None


def as_datetime(v: Any) -> dt.datetime | None:
    if isinstance(v, dt.datetime):
        return v
    if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}T", v):
        s = re.sub(r"([+-]\d\d)(\d\d)$", r"\1:\2", v.replace("Z", "+00:00"))
        return dt.datetime.fromisoformat(s)
    return None


def evaluate(
    expr: Any,
    item: Any,
    resolve: Callable[[Any, str], list | None],
    functions: Callable[[str, str], list] | None = None,
    now: dt.datetime | None = None,
) -> bool:
    now = now or dt.datetime.now(dt.timezone.utc)
    if expr is None:
        return True
    if isinstance(expr, Bool):
        if expr.op == "and":
            return all(evaluate(c, item, resolve, functions, now) for c in expr.children)
        if expr.op == "or":
            return any(evaluate(c, item, resolve, functions, now) for c in expr.children)
        return not evaluate(expr.children[0], item, resolve, functions, now)
    c: Clause = expr
    have = resolve(item, c.field)
    if have is None:
        raise QLError(f"Field '{c.field}' does not exist or you do not have permission to view it.")
    have = [h for h in have if h is not None and h != ""]
    if c.op == "is":
        return not have
    if c.op == "isnot":
        return bool(have)

    def expand(v: Value) -> list:
        if v.func:
            if functions is None:
                raise QLError(f"Unknown function {v.text}()")
            return functions(v.func, c.field)
        return [v.text]

    wanted: list = []
    for v in c.values:
        wanted.extend(expand(v))

    def eq(a: Any, b: Any) -> bool:
        da, db = as_datetime(a), parse_date(str(b), now) if not isinstance(b, dt.datetime) else b
        if da is not None and db is not None:
            return da == db
        return str(a).lower() == str(b).lower()

    if c.op in ("=", "in"):
        return any(eq(h, w) for h in have for w in wanted)
    if c.op in ("!=", "notin"):
        return bool(have) and not any(eq(h, w) for h in have for w in wanted)
    if c.op in ("~", "!~"):
        needle = str(wanted[0]).lower().strip("*")
        hit = any(needle in str(h).lower() for h in have)
        return hit if c.op == "~" else not hit
    # Range operators: dates or numbers.
    bound = wanted[0]
    for h in have:
        hd = as_datetime(h)
        if hd is not None:
            bd = parse_date(str(bound), now)
            if bd is None:
                raise QLError(f"Date value '{bound}' for field '{c.field}' is invalid.")
            a, b = hd, bd
        else:
            try:
                a, b = float(h), float(bound)
            except (TypeError, ValueError):
                raise QLError(f"Operator '{c.op}' is not supported by field '{c.field}'.") from None
        if (c.op == ">" and a > b) or (c.op == ">=" and a >= b) or (c.op == "<" and a < b) or (c.op == "<=" and a <= b):
            return True
    return False


def clause_fields(expr: Any) -> list[str]:
    if expr is None:
        return []
    if isinstance(expr, Bool):
        return [f for c in expr.children for f in clause_fields(c)]
    return [expr.field]
