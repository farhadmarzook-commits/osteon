/**
 * The Review Heatmap add-on (spec 0007 §2): a year of answers, coloured relative to the daily
 * average, with the forecast greyed in the future, and streak stats underneath.
 * Clicking a day opens Browse on the cards answered (or due) that day.
 */
import type FlashcardsPlugin from "../main";
import {
  activityByDay,
  dayDate,
  forecast,
  heatLevel,
  heatmapThresholds,
  percentLevel,
  reviewRows,
  streakLevel,
  streakStats,
  studyDay,
  type ReviewRow,
} from "../core/stats";
import type { QueueItem } from "../core/queue";

const SVG = "http://www.w3.org/2000/svg";
const CELL = 11;
const GAP = 2;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface HeatmapData {
  items: QueueItem[];
  rows: ReviewRow[];
}

export function heatmapData(plugin: FlashcardsPlugin, deck: string | null): HeatmapData {
  const items = plugin.items(deck);
  const rows = reviewRows(
    items.flatMap((i) => (i.state ? [i.state] : [])),
    plugin.settings.dayStartHour,
  );
  return { items, rows };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function dateLabel(day: number): string {
  const d = dayDate(day);
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** A tooltip that follows the pointer, shared by the heatmap and the charts. */
export function tooltip(host: HTMLElement): { show: (e: MouseEvent, html: string) => void; hide: () => void } {
  const tip = host.createDiv({ cls: "fc-tip" });
  tip.hide();
  return {
    show(e, text) {
      tip.empty();
      for (const [i, line] of text.split("\n").entries()) {
        if (i) tip.createEl("br");
        tip.appendText(line);
      }
      tip.show();
      const box = host.getBoundingClientRect();
      const x = Math.min(e.clientX - box.left + 12, Math.max(0, box.width - tip.offsetWidth - 4));
      tip.style.left = `${x}px`;
      tip.style.top = `${e.clientY - box.top + 14}px`;
    },
    hide() {
      tip.hide();
    },
  };
}

/**
 * Render the heatmap into `el`. `deck` limits it to one deck (null = everything).
 * `yearState` keeps the shown year between re-renders.
 */
export function renderHeatmap(
  el: HTMLElement,
  plugin: FlashcardsPlugin,
  deck: string | null,
  data: HeatmapData,
  yearState: { year?: number },
  onYear: () => void,
): void {
  const wrap = el.createDiv({ cls: "fc-heatmap" });
  const startHour = plugin.settings.dayStartHour;
  const today = studyDay(Date.now(), startHour);
  const thisYear = dayDate(today).getUTCFullYear();
  const year = yearState.year ?? thisYear;

  const activity = activityByDay(data.rows);
  const due = forecast(data.items, today, startHour);
  const stats = streakStats(activity, today);
  const th = heatmapThresholds(stats.dailyAvg);

  const nav = wrap.createDiv({ cls: "fc-hm-nav" });
  const btn = (icon: string, label: string, fn: () => void) => {
    const b = nav.createEl("button", { cls: "fc-hm-btn", text: icon, attr: { "aria-label": label } });
    b.onclick = fn;
  };
  btn("‹", "Previous year", () => {
    yearState.year = year - 1;
    onYear();
  });
  btn("○", "This year", () => {
    yearState.year = undefined;
    onYear();
  });
  btn("›", "Next year", () => {
    yearState.year = year + 1;
    onYear();
  });

  const tip = tooltip(wrap);
  const first = Math.round(Date.UTC(year, 0, 1) / 86400000);
  const last = Math.round(Date.UTC(year, 11, 31) / 86400000);
  const lead = dayDate(first).getUTCDay(); // Sunday-first rows
  const weeks = Math.ceil((last - first + 1 + lead) / 7);
  const LEFT = 26;
  const TOP = 14;
  const width = LEFT + weeks * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "fc-hm-svg");
  wrap.appendChild(svg);

  const text = (x: number, y: number, s: string, cls: string) => {
    const t = document.createElementNS(SVG, "text");
    t.setAttribute("x", String(x));
    t.setAttribute("y", String(y));
    t.setAttribute("class", cls);
    t.textContent = s;
    svg.appendChild(t);
  };
  for (const [i, name] of ["Mon", "Wed", "Fri"].entries()) text(0, TOP + (2 * i + 1) * (CELL + GAP) + CELL - 2, name, "fc-hm-label");

  let lastMonth = -1;
  const deckTerm = deck ? ` deck:"${deck}"` : "";
  for (let d = first; d <= last; d++) {
    const idx = d - first + lead;
    const col = Math.floor(idx / 7);
    const row = idx % 7;
    const date = dayDate(d);
    if (date.getUTCMonth() !== lastMonth && row <= 1) {
      lastMonth = date.getUTCMonth();
      text(LEFT + col * (CELL + GAP), 10, MONTHS[lastMonth], "fc-hm-label");
    }
    const rect = document.createElementNS(SVG, "rect");
    rect.setAttribute("x", String(LEFT + col * (CELL + GAP)));
    rect.setAttribute("y", String(TOP + row * (CELL + GAP)));
    rect.setAttribute("width", String(CELL));
    rect.setAttribute("height", String(CELL));
    rect.setAttribute("rx", "2");
    let cls: string;
    let label: string;
    let search: string | null = null;
    if (d <= today) {
      const n = activity.get(d) ?? 0;
      // Today shows what's been done; the day's remaining due cards show in its tooltip.
      cls = `fc-hm-day fc-hm-l${heatLevel(n, th)}`;
      label = `${plural(n, "review")} on ${dateLabel(d)}`;
      if (d === today && due.get(d)) label += `\n${plural(due.get(d)!, "card")} due`;
      if (n) search = `prop:rated=${d - today}${deckTerm}`;
    } else {
      const n = due.get(d) ?? 0;
      cls = `fc-hm-day fc-hm-f${n ? Math.min(4, Math.ceil(heatLevel(n, th) / 2.5)) : 0}`;
      label = `${plural(n, "card")} due on ${dateLabel(d)}`;
      if (n) search = `prop:due=${d - today}${deckTerm}`;
    }
    if (d === today) cls += " fc-hm-today";
    if (search) cls += " fc-hm-click";
    rect.setAttribute("class", cls);
    rect.addEventListener("mousemove", (e) => tip.show(e, label));
    rect.addEventListener("mouseleave", () => tip.hide());
    if (search) {
      const q = search;
      rect.addEventListener("click", () => void plugin.openBrowse(q));
    }
    svg.appendChild(rect);
  }
  wrap.createDiv({ cls: "fc-hm-year", text: String(year) });

  const line = wrap.createDiv({ cls: "fc-hm-stats" });
  const stat = (name: string, value: string, level: number, title: string) => {
    const s = line.createSpan({ cls: "fc-hm-stat", attr: { title } });
    s.createSpan({ text: `${name}: ` });
    s.createSpan({ cls: `fc-hm-v fc-hm-t${level}`, text: value });
  };
  stat("Daily average", plural(stats.dailyAvg, "card"), heatLevel(stats.dailyAvg, th), "Average reviews on days you studied");
  stat("Days learned", `${stats.pctDaysLearned}%`, percentLevel(stats.pctDaysLearned), "Share of days with reviews since your first review");
  stat("Longest streak", plural(stats.longestStreak, "day"), streakLevel(stats.longestStreak), "Longest run of consecutive days with reviews");
  stat("Current streak", plural(stats.currentStreak, "day"), streakLevel(stats.currentStreak), "Consecutive days with reviews, up to today");
}
