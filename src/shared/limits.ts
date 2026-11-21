/**
 * What a visitor at the email limit is told: that they are at the limit, and the exact time the
 * next agent is free (the oldest start of the last 24 hours plus 24 hours, rounded up to the
 * minute so it is never early).
 *
 * The browser calls it with no time zone and gets the visitor's own clock ("tomorrow at 5:11 PM").
 * The server has no time zone to use, so it passes "UTC" and the time says so; the page replaces
 * that text with the local one (`limit: "agents"` and `retryAt` in the 429).
 */
export function agentLimitMessage(retryAt: string | null | undefined, options: { now?: number; timeZone?: string } = {}): string {
  const said = "You've hit the limit on the number of agents you can create per day.";
  const at = retryAt ? Math.ceil(Date.parse(retryAt) / 60_000) * 60_000 : NaN;
  if (!Number.isFinite(at)) return `${said} Try again tomorrow.`;
  const now = options.now ?? Date.now();
  const zone = options.timeZone ? { timeZone: options.timeZone } : {};
  const day = (ms: number): string => new Intl.DateTimeFormat("en-CA", { ...zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  const time = new Intl.DateTimeFormat("en-US", { ...zone, hour: "numeric", minute: "2-digit" }).format(at) + (options.timeZone === "UTC" ? " UTC" : "");
  if (at <= now) return `${said} Try again now.`;
  const days = Math.round((Date.parse(`${day(at)}T00:00:00Z`) - Date.parse(`${day(now)}T00:00:00Z`)) / 86_400_000);
  const when = days <= 0 ? "today" : days === 1 ? "tomorrow" : `on ${new Intl.DateTimeFormat("en-US", { ...zone, weekday: "long" }).format(at)}`;
  return `${said} Try again ${when} at ${time}.`;
}
