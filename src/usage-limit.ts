const MINUTE_MS = 60_000;
const WINDOW_MS = 5 * 60 * MINUTE_MS;

/** Resolve the CLI's local clock time relative to the recorded failure, including midnight and DST. */
export function claudeUsageRetryAt(reason: string | null | undefined, observedAt: number): number | null {
  const match = /^you['’]ve hit your 5-hour limit\s*·\s*resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([a-z0-9_+/-]+)\)$/i.exec(reason?.trim() ?? '');
  if (!match || !Number.isFinite(observedAt)) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  let clock: Intl.DateTimeFormat;
  try {
    clock = new Intl.DateTimeFormat('en-GB', { timeZone: match[4], hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
  const resetHour = hour % 12 + (match[3].toLowerCase() === 'pm' ? 12 : 0);
  const resetClock = String(resetHour).padStart(2, '0') + ':' + match[2];
  const start = Math.floor(observedAt / MINUTE_MS) * MINUTE_MS;
  for (let instant = start; instant <= observedAt + WINDOW_MS; instant += MINUTE_MS) {
    // The message gives minutes only. Wait until the displayed reset minute has finished.
    if (clock.format(instant) === resetClock) return instant + MINUTE_MS;
  }
  return null;
}
