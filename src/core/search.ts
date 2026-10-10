/**
 * Anki's search syntax, the common terms (spec 0003 §7). Terms are ANDed; `-term` negates;
 * "quoted phrases" keep spaces.
 *   deck:Ortho  tag:high-yield  note:ACL (the card's note, or a note it's linked to, spec 0011)  is:new|learn|review|due|suspended|buried|marked
 *   flag:0-7  prop:ivl>30  prop:due<=0  prop:lapses>=3  prop:reps=0  prop:d>7  prop:s<5
 *   is:onebyone (answers reveal one by one, 🦴)  onebyone:on|off (switched by hand)  onebyone:auto (by the automatic rule); is:crown / crown: still work
 *   missed:1 (cards of notes missed at least once on an imported exam, spec 0012)
 *   rated:7 (answered in the last 7 days)  rated:7:1 (answered Again in the last 7 days)  prop:rated=-3 (answered exactly 3 days ago)
 *   front:word (the card's front line only, answers included)
 *   A or B (either side; "or" binds loosest, as in Anki without brackets)
 *   plain text (front, answer and back)
 */
import { State } from "ts-fsrs";
import { inDeck, type CardRef } from "./collection";
import { dayStart, nextDayStart } from "./day";
import type { CardState } from "./state";

export interface SearchItem {
  ref: CardRef;
  state?: CardState;
}

type Pred = (i: SearchItem) => boolean;

export function tokenize(query: string): string[] {
  const out: string[] = [];
  const re = /(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
  for (const m of query.matchAll(re)) {
    out.push(`${m[1]}${m[2] ? m[2] + ":" : ""}${m[3] ?? m[4]}`);
  }
  return out.filter((t) => t !== "" && t !== "-");
}

const PROP = /^(ivl|due|reps|lapses|d|s|rated)(>=|<=|!=|>|<|=)(-?\d+(?:\.\d+)?)$/;

/** A card's linked study notes (spec 0011), for `note:`. */
export type LinkedOf = (ref: CardRef) => readonly string[];

/** Lookups some terms need from outside the card: linked notes (`note:`), exam misses (`missed:`). */
export interface SearchContext {
  linked?: LinkedOf;
  /** Times a note was missed on imported exams (spec 0012). */
  missed?: (notePath: string) => number;
  /** A card's crown status: "on"/"off" = switched by hand, "auto" = crowns by the rule, "none" = no crowns. */
  crown?: (ref: CardRef) => "on" | "off" | "auto" | "none";
}

export function compileSearch(query: string, nowMs: number, dayStartHour: number, ctx: SearchContext = {}): Pred {
  // `or` splits the query into alternatives, each an AND of its terms.
  const groups: string[][] = [[]];
  for (const t of tokenize(query)) {
    if (t.toLowerCase() === "or") groups.push([]);
    else groups[groups.length - 1].push(t);
  }
  const alts = groups.filter((g) => g.length).map((g) => compileAll(g, nowMs, dayStartHour, ctx));
  if (alts.length <= 1) return alts[0] ?? (() => true);
  return (i) => alts.some((p) => p(i));
}

function compileAll(tokens: string[], nowMs: number, dayStartHour: number, ctx: SearchContext): Pred {
  const { linked, missed, crown } = ctx;
  const dayEnd = nextDayStart(nowMs, dayStartHour);
  const today = dayStart(nowMs, dayStartHour);
  const preds: Pred[] = [];
  for (const raw of tokens) {
    const neg = raw.startsWith("-");
    const tok = neg ? raw.slice(1) : raw;
    const colon = tok.indexOf(":");
    const field = colon > 0 ? tok.slice(0, colon).toLowerCase() : "";
    const value = colon > 0 ? tok.slice(colon + 1) : tok;
    const v = value.toLowerCase();
    let p: Pred;
    switch (field) {
      case "deck":
        p = (i) => inDeck(i.ref.deck, value);
        break;
      case "tag":
        p = (i) => i.ref.card.tags.some((t) => t.toLowerCase() === v || t.toLowerCase().startsWith(v + "/"));
        break;
      case "note":
        p = (i) => i.ref.path.toLowerCase().includes(v) || !!linked?.(i.ref).some((n) => n.toLowerCase().includes(v));
        break;
      case "missed": {
        // missed:N — the card's note, or a note it's linked to, was missed N+ times (missed = missed:1).
        const n = Math.max(1, Number(v) || 1);
        const count = (i: SearchItem) => Math.max(missed?.(i.ref.path) ?? 0, ...(linked?.(i.ref) ?? []).map((p) => missed?.(p) ?? 0));
        p = (i) => count(i) >= n;
        break;
      }
      case "front":
        p = (i) => i.ref.card.front.toLowerCase().includes(v);
        break;
      case "crown":
      case "onebyone":
        p = (i) => crown?.(i.ref) === v;
        break;
      case "flag":
        p = (i) => (i.state?.flag ?? 0) === Number(v);
        break;
      case "is":
        p = v === "crown" || v === "onebyone" ? (i) => crown?.(i.ref) === "on" || crown?.(i.ref) === "auto" : isPred(v, nowMs, dayEnd);
        break;
      case "rated": {
        // Anki: rated:1 is today, rated:7 the last 7 days; rated:7:1 only answers of Again (1–4).
        const [days, ease] = v.split(":");
        const n = Math.max(1, Math.floor(Number(days)) || 1);
        const since = today - (n - 1) * 86400000;
        const rating = ease ? (["again", "hard", "good", "easy"] as const)[Number(ease) - 1] : undefined;
        p = (i) => !!i.state?.reviews.some((r) => Date.parse(r.ts) >= since && (!rating || r.rating === rating));
        break;
      }
      case "prop": {
        const m = PROP.exec(v);
        if (!m) {
          p = () => false;
          break;
        }
        const [, prop, op, num] = m;
        const target = Number(num);
        const cmp = (val: number) =>
          op === ">" ? val > target
          : op === "<" ? val < target
          : op === ">=" ? val >= target
          : op === "<=" ? val <= target
          : op === "!=" ? val !== target
          : val === target;
        if (prop === "rated") {
          // Days relative to today (0 today, -1 yesterday) of any answer.
          p = (i) => !!i.state?.reviews.some((r) => cmp(Math.floor((Date.parse(r.ts) - today) / 86400000)));
          break;
        }
        p = (i) => {
          const s = i.state;
          if (!s) return false;
          const c = s.card;
          const val =
            prop === "ivl" ? c.scheduled_days
            : prop === "due" ? Math.floor((c.due.getTime() - today) / 86400000)
            : prop === "reps" ? c.reps
            : prop === "lapses" ? c.lapses
            : prop === "d" ? c.difficulty
            : c.stability;
          return cmp(val);
        };
        break;
      }
      default: {
        const text = tok.toLowerCase();
        p = (i) => `${i.ref.card.front}\n${i.ref.card.answer}\n${i.ref.card.back}`.toLowerCase().includes(text);
      }
    }
    preds.push(neg ? (i) => !p(i) : p);
  }
  return (i) => preds.every((p) => p(i));
}

function isPred(v: string, nowMs: number, dayEnd: number): Pred {
  const state = (i: SearchItem) => i.state?.card.state ?? State.New;
  switch (v) {
    case "new":
      return (i) => state(i) === State.New;
    case "learn":
      return (i) => state(i) === State.Learning || state(i) === State.Relearning;
    case "review":
      return (i) => state(i) === State.Review;
    case "due":
      return (i) => state(i) !== State.New && !!i.state && i.state.card.due.getTime() < dayEnd;
    case "suspended":
      return (i) => !!i.state?.suspended;
    case "buried":
      return (i) => (i.state?.buriedUntil ?? 0) > nowMs;
    case "marked":
      return (i) => !!i.state?.marked;
    default:
      return () => false;
  }
}
