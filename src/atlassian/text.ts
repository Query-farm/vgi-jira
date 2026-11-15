/**
 * Plain-text extraction from Atlassian rich-text formats.
 *
 * - **ADF** (Atlassian Document Format, Jira Cloud v3 descriptions/comments/worklog
 *   comments): a JSON tree of block and inline nodes.
 * - **Storage format** (Confluence page/comment bodies): XHTML with `ac:` / `ri:`
 *   macro elements.
 *
 * Both turn into readable text: blocks end with newlines, list items get "- ",
 * table cells are tab-separated, mentions/emoji/cards keep their visible text.
 */

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

const BLOCKS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "rule",
  "panel",
  "mediaSingle",
  "mediaGroup",
  "expand",
  "nestedExpand",
  "decisionList",
  "taskList",
  "layoutSection",
  "layoutColumn",
  "table",
]);

function adfInline(n: AdfNode, out: string[], listDepth: number): void {
  switch (n.type) {
    case "text":
      out.push(n.text ?? "");
      return;
    case "hardBreak":
      out.push("\n");
      return;
    case "mention":
      out.push(String(n.attrs?.text ?? ""));
      return;
    case "emoji":
      out.push(String(n.attrs?.text ?? n.attrs?.shortName ?? ""));
      return;
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      out.push(String(n.attrs?.url ?? ""));
      return;
    case "date": {
      const ts = Number(n.attrs?.timestamp);
      out.push(Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : "");
      return;
    }
    case "status":
      out.push(String(n.attrs?.text ?? ""));
      return;
    case "rule":
      out.push("---\n");
      return;
    case "bulletList":
    case "orderedList":
      for (const [i, item] of (n.content ?? []).entries()) {
        out.push("  ".repeat(listDepth), n.type === "orderedList" ? `${i + 1}. ` : "- ");
        adfChildren(item, out, listDepth + 1);
        if (!out[out.length - 1]?.endsWith("\n")) out.push("\n");
      }
      return;
    case "taskItem":
    case "decisionItem":
      out.push(n.attrs?.state === "DONE" ? "[x] " : "[ ] ");
      adfChildren(n, out, listDepth);
      out.push("\n");
      return;
    case "tableRow": {
      const cells = (n.content ?? []).map((cell) => {
        const parts: string[] = [];
        adfChildren(cell, parts, listDepth);
        return parts
          .join("")
          .replace(/\s*\n\s*/g, " ")
          .trim();
      });
      out.push(cells.join("\t"), "\n");
      return;
    }
    default:
      if (n.type && BLOCKS.has(n.type)) {
        adfChildren(n, out, listDepth);
        if (n.type !== "table" && !out[out.length - 1]?.endsWith("\n")) out.push("\n");
        return;
      }
      adfChildren(n, out, listDepth);
  }
}

function adfChildren(n: AdfNode, out: string[], listDepth: number): void {
  for (const c of n.content ?? []) adfInline(c, out, listDepth);
}

/** ADF document → plain text (null for null). A plain string (Data Center wiki markup) passes through. */
export function adfToText(doc: unknown): string | null {
  if (doc == null) return null;
  if (typeof doc === "string") return doc;
  if (typeof doc !== "object") return String(doc);
  const out: string[] = [];
  adfChildren(doc as AdfNode, out, 0);
  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  trade: "™",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });
}

const BLOCK_TAGS =
  /^(p|div|h[1-6]|li|tr|br|hr|blockquote|pre|table|ul|ol|ac:task|ac:layout-section|ac:layout-cell|ac:rich-text-body|ac:plain-text-body)$/i;

/** Confluence storage-format XHTML → plain text. */
export function storageToText(xhtml: unknown): string | null {
  if (xhtml == null) return null;
  const s = String(xhtml);
  let out = "";
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let listDepth = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[1] !== undefined) out += m[1];
    else if (m[6] !== undefined) out += decodeEntities(m[6]);
    else if (m[3]) {
      const tag = m[3].toLowerCase();
      const closing = m[2] === "/";
      const selfClosing = m[5] === "/";
      if (tag === "ul" || tag === "ol") listDepth += closing ? -1 : selfClosing ? 0 : 1;
      if (!closing && tag === "li") out += `${"  ".repeat(Math.max(0, listDepth - 1))}- `;
      else if (tag === "td" || tag === "th") {
        if (closing) out += "\t";
      } else if (tag === "ri:user" && !closing) {
        const id = /ri:(?:account-id|username)="([^"]*)"/.exec(m[4] ?? "");
        out += id ? `@${id[1]}` : "";
      } else if (tag === "ac:emoticon" && !closing) {
        const fb = /ac:emoji-fallback="([^"]*)"/.exec(m[4] ?? "");
        out += fb ? decodeEntities(fb[1] ?? "") : "";
      } else if (BLOCK_TAGS.test(tag) && (closing || selfClosing || tag === "br" || tag === "hr")) {
        out = out.replace(/\t$/, "");
        if (!out.endsWith("\n")) out += "\n";
      }
    }
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
