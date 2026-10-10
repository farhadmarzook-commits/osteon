/** Anki's study day: runs from `startHour` (default 4 am) to the same time next day, local time. */

export function dayStart(nowMs: number, startHour: number): number {
  const d = new Date(nowMs);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), startHour, 0, 0, 0);
  if (start.getTime() > nowMs) start.setDate(start.getDate() - 1);
  return start.getTime();
}

export function nextDayStart(nowMs: number, startHour: number): number {
  const s = new Date(dayStart(nowMs, startHour));
  s.setDate(s.getDate() + 1);
  return s.getTime();
}
