/**
 * Anki's "Set due date" input (spec 0003 §3): "0" = today, "3" = in 3 days, "3-7" = a random
 * day in that range. A trailing "!" is accepted (Anki uses it to also reset the interval; here
 * the due date is what's changed). Returns the due time, or null for invalid input.
 */
import { dayStart } from "./day";

export function parseDueInput(input: string, nowMs: number, dayStartHour: number, random = Math.random): Date | null {
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*!?\s*$/.exec(input);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] !== undefined ? Number(m[2]) : lo;
  if (hi < lo || hi > 36500) return null;
  const days = lo + Math.floor(random() * (hi - lo + 1));
  if (days === 0) return new Date(nowMs);
  const start = new Date(dayStart(nowMs, dayStartHour));
  start.setDate(start.getDate() + days);
  return start;
}
