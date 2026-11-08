import type { Perception } from "./perception.ts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const HOUR_MS = 3_600_000;
export const TIME_ENTRY_TYPE = "pi-souls:time";
const DAY_MS = 24 * HOUR_MS;

/** Watch-face style: big time first, then the small date window. No year, like a real watch. */
export function formatClock(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes} · ${DAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function formatElapsed(ms: number): string {
  if (ms >= DAY_MS) {
    const days = Math.floor(ms / DAY_MS);
    const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
    return hours ? `${days}d ${hours}h` : `${days}d`;
  }
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.round((ms % HOUR_MS) / 60_000);
  if (minutes === 60) return `${hours + 1}h`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** Refresh the watch on human moments, at most once an hour. */
export function timePerception(lastNoteAt?: number): Perception {
  return (moment, world) => {
    if (moment.kind !== "human" || !Number.isFinite(world.now)) return undefined;
    if (lastNoteAt !== undefined && Number.isFinite(lastNoteAt) && world.now - lastNoteAt < HOUR_MS) return undefined;
    const clock = `⌚ ${formatClock(new Date(world.now))}`;
    const away = world.absenceMs !== undefined && Number.isFinite(world.absenceMs) && world.absenceMs >= HOUR_MS
      ? formatElapsed(world.absenceMs)
      : undefined;
    return { text: away ? `${clock}\n(${away} since *human* was last present)` : clock };
  };
}
