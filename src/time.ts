const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Watch-face style: big time first, then the small date window. No year, like a real watch. */
function formatClock(now: number): string {
  const date = new Date(now);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes} · ${DAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function formatElapsed(ms: number): string {
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

/**
 * Refresh the watch at most once an hour; the parenthetical appears only when the
 * human has actually been away for an hour or more. Undefined when neither is due.
 */
export function formatTimeReminder(now: number, lastNoteAt?: number, lastHumanAt?: number, wrap = true): string | undefined {
  if (!Number.isFinite(now)) return undefined;
  const noteDue = lastNoteAt === undefined || !Number.isFinite(lastNoteAt) || now - lastNoteAt >= HOUR_MS;
  if (!noteDue) return undefined;
  const away = lastHumanAt !== undefined && Number.isFinite(lastHumanAt) && now - lastHumanAt >= HOUR_MS
    ? formatElapsed(now - lastHumanAt)
    : undefined;
  const text = away === undefined
    ? `⌚ ${formatClock(now)}`
    : `⌚ ${formatClock(now)}\n(${away} since *human* was last present)`;
  return wrap ? `<system-reminder>\n${text}\n</system-reminder>` : text;
}
