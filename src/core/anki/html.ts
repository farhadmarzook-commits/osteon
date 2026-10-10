/**
 * Anki field HTML → Markdown for cards in a #flashcards note (spec 0006 §2). Pure (no DOM), so
 * it runs in tests and on every platform.
 */

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rarr: "→",
  larr: "←",
  harr: "↔",
  uarr: "↑",
  darr: "↓",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  le: "≤",
  ge: "≥",
  ne: "≠",
  micro: "µ",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  mu: "μ",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : undefined;
}

/** decodeURIComponent that never throws (Anki filenames can contain a bare "%"). */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export type MediaResolver = (filename: string) => string | null;

/** Marks an emphasis marker that was just opened, until the spaces after it are moved in front. */
const OPENED = "\uE000";

/** Convert one Anki field to Markdown lines (no escaping yet). */
export function htmlToMarkdown(html: string, media: MediaResolver): string {
  let s = html.replace(/\r\n?/g, "\n");
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Sounds and MathJax.
  s = s.replace(/\[sound:([^\]]+)\]/g, (_m, f: string) => {
    const p = media(f.trim());
    return p ? `![[${p}]]` : "";
  });
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_m, x: string) => `$${x.trim()}$`);
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_m, x: string) => `$${x.trim()}$`);
  // Newlines in the source HTML are not line breaks in Anki.
  s = s.replace(/\n/g, " ");

  const out: string[] = [];
  const listStack: Array<"ul" | "ol"> = [];
  const olCount: number[] = [];
  const linkStack: Array<string | undefined> = [];
  // Open emphasis, so it can be closed and reopened across line breaks (Markdown can't span them).
  const emph: string[] = [];
  const closeMarker = (marker: string) => {
    // "<b>word </b>" → "**word** ": Markdown needs the marker right after the text.
    const last = out[out.length - 1] ?? "";
    const trail = /\s+$/.exec(last)?.[0] ?? "";
    if (trail) out[out.length - 1] = last.slice(0, -trail.length);
    out.push(marker + trail);
  };
  let pos = 0;
  const TAG = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;
  for (let m = TAG.exec(s); m; m = TAG.exec(s)) {
    if (m.index > pos) out.push(s.slice(pos, m.index));
    pos = m.index + m[0].length;
    const raw = m[0];
    const name = m[1].toLowerCase();
    const closing = raw.startsWith("</");
    switch (name) {
      case "br":
        out.push(emph.length ? `${[...new Set(emph)].reverse().join("")}\n${[...new Set(emph)].map((e) => OPENED + e).join("")}` : "\n");
        break;
      case "div":
      case "p":
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
      case "tr":
      case "blockquote":
        out.push("\n");
        if (!closing && name.startsWith("h")) out.push("**");
        if (closing && name.startsWith("h")) out.splice(out.length - 1, 0, "**");
        break;
      case "td":
      case "th":
        if (closing) out.push(" | ");
        break;
      case "b":
      case "strong":
      case "i":
      case "em": {
        const marker = name === "b" || name === "strong" ? "**" : "*";
        // Bold inside bold ("<b>a <b>b</b> c</b>") shows no differently: only the outer pair is written.
        if (closing) {
          const at = emph.lastIndexOf(marker);
          if (at < 0) break;
          emph.splice(at, 1);
          if (!emph.includes(marker)) closeMarker(marker);
        } else {
          if (!emph.includes(marker)) out.push(OPENED + marker);
          emph.push(marker);
        }
        break;
      }
      case "u":
      case "sub":
      case "sup":
        out.push(closing ? `</${name}>` : `<${name}>`);
        break;
      case "ul":
      case "ol":
        if (closing) {
          listStack.pop();
          olCount.pop();
        } else {
          listStack.push(name);
          olCount.push(0);
        }
        out.push("\n");
        break;
      case "li":
        if (!closing) {
          const depth = Math.max(0, listStack.length - 1);
          const type = listStack[listStack.length - 1] ?? "ul";
          let marker = "- ";
          if (type === "ol") {
            olCount[olCount.length - 1] = (olCount[olCount.length - 1] ?? 0) + 1;
            marker = `${olCount[olCount.length - 1]}. `;
          }
          out.push(`\n${"    ".repeat(depth)}${marker}`);
        }
        break;
      case "img": {
        const src = attr(raw, "src");
        if (!src) break;
        if (/^(https?:|data:)/i.test(src)) out.push(`![](${src})`);
        else {
          const p = media(safeDecode(src.split("?")[0]));
          if (p) out.push(`![[${p}]]`);
        }
        break;
      }
      case "a": {
        if (!closing) {
          const href = attr(raw, "href");
          linkStack.push(href);
          if (href && /^https?:/i.test(href)) out.push("[");
        } else {
          const href = linkStack.pop();
          if (href && /^https?:/i.test(href)) out.push(`](${href})`);
        }
        break;
      }
      case "hr":
        out.push("\n");
        break;
      default:
        // span, font, table, tbody, etc.: keep the content, drop the tag.
        break;
    }
  }
  out.push(s.slice(pos));

  // "<b> word</b>" → " **word**": Markdown needs the marker right before the text.
  let joined = out.join("");
  const LEAD = new RegExp(`${OPENED}(\\*+)([ \\t\\u00a0]+|&nbsp;)`, "g");
  for (let i = 0; i < 4 && LEAD.test(joined); i++) joined = joined.replace(LEAD, `$2${OPENED}$1`);
  let md = decodeEntities(joined.split(OPENED).join(""));
  md = md
    .split("\n")
    .map((l) => {
      // Keep list indentation (from <li> nesting); collapse other runs of spaces.
      const indent = /^( {4})*(?=(- |\d+\. ))/.exec(l)?.[0] ?? "";
      const body = l.slice(indent.length).replace(/[ \t\u00a0]+/g, " ").trim();
      // Empty emphasis from Anki's "<b> </b>" ("** **", "****", "* *") pairs with real markers
      // elsewhere on the line and breaks its rendering (and the crowns): drop it.
      const tidy = body
        .replace(/\*\*(\s+)\*\*/g, "$1")
        .replace(/(?<!\*)\*(\s+)\*(?!\*)/g, "$1")
        .replace(/\*\*\*\*/g, "")
        .replace(/(^|\s)\*\*(?=\s|$)/g, "$1");
      return body ? indent + tidy.trim() : "";
    })
    .filter((l) => l.trim() !== "")
    .join("\n");
  // Tidy table cells ("a |  | b | " → "a | b").
  return md.replace(/( \| )+$/gm, "").replace(/(\s\|\s*){2,}/g, " | ").replace(/\s+\|$/gm, "").trim();
}

/** Anki cloze markup, which must survive escaping. */
const ANKI_CLOZE = /\{\{c\d+::[\s\S]*?\}\}/g;

/**
 * Escape text that would change meaning in a #flashcards note: stray `==` (cloze), `::` (basic
 * card), `#word` (tag), a leading `#` (heading), `>` (quote) or `|` (table), and code fences.
 * Anki cloze markup is left untouched.
 */
export function escapeCardText(line: string, opts: { keepAnkiCloze: boolean; front?: boolean }): string {
  const parts: string[] = [];
  let pos = 0;
  const esc = (t: string) =>
    t
      .replace(/==/g, "\\=\\=")
      .replace(/:(?=:)/g, ":\\")
      .replace(/\{\{/g, "\\{\\{")
      .replace(/(^|\s)#(?=[A-Za-z_/-])/g, "$1\\#");
  if (opts.keepAnkiCloze) {
    for (const m of line.matchAll(ANKI_CLOZE)) {
      parts.push(esc(line.slice(pos, m.index)));
      parts.push(m[0]);
      pos = (m.index ?? 0) + m[0].length;
    }
  }
  parts.push(esc(line.slice(pos)));
  let out = parts.join("");
  out = out.replace(/^(\s*)(#|>|\||```|~~~|\$\$)/, "$1\\$2");
  // A front line that starts like a list item would be read as a bullet card.
  // ("\\-" and "1\\." render as "-" and "1."; a backslash before a digit would show.)
  if (opts.front) out = out.replace(/^(\s*)([-*+])(\s)/, "$1\\$2$3").replace(/^(\s*\d+)([.)])(\s)/, "$1\\$2$3");
  return out;
}
