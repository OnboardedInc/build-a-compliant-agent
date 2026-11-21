import { test } from "node:test";
import assert from "node:assert/strict";
import { countUse, MAX_REWRITES_PER_DAY, MAX_SESSIONS_PER_DAY, MAX_STARTS_PER_EMAIL } from "../../src/server/services/limits.ts";
import { agentLimitMessage } from "../../src/shared/limits.ts";

test("the limits Sam set", () => {
  assert.equal(MAX_REWRITES_PER_DAY, 10);
  assert.equal(MAX_STARTS_PER_EMAIL, 10);
  assert.equal(MAX_SESSIONS_PER_DAY, 15);
});

test("a visitor at the email limit is told so, with the exact time the next agent is free", () => {
  const said = "You've hit the limit on the number of agents you can create per day.";
  const now = Date.parse("2026-11-21T12:00:00.000Z");
  // The server has no time zone for the visitor: it says UTC.
  assert.equal(agentLimitMessage("2026-11-21T17:11:32.858Z", { now, timeZone: "UTC" }), `${said} Try again today at 5:12 PM UTC.`);
  assert.equal(agentLimitMessage("2026-11-22T02:36:00.000Z", { now, timeZone: "UTC" }), `${said} Try again tomorrow at 2:36 AM UTC.`);
  // The page says the same moment on the visitor's own clock, and the day is theirs too.
  assert.equal(agentLimitMessage("2026-11-22T02:36:00.000Z", { now, timeZone: "America/Chicago" }), `${said} Try again today at 8:36 PM.`);
  assert.equal(agentLimitMessage("2026-11-22T09:04:00.000Z", { now, timeZone: "America/Los_Angeles" }), `${said} Try again tomorrow at 1:04 AM.`);
  assert.equal(agentLimitMessage("2026-11-21T11:00:00.000Z", { now, timeZone: "UTC" }), `${said} Try again now.`);
  assert.equal(agentLimitMessage(null, { now }), `${said} Try again tomorrow.`);
  assert.equal(agentLimitMessage("not a date", { now }), `${said} Try again tomorrow.`);
});

test("a use is allowed when the database counted it, and a missing table lets the request through", async () => {
  const db = (changes) => ({ prepare: (sql) => ({ bind: (...values) => ({ run: async () => { db.last = { sql, values }; if (changes === null) throw new Error("no such table"); return { meta: { changes } }; } }) }) });
  assert.equal(await countUse(db(1), "questions:bld_1", 10), true);
  assert.equal(await countUse(db(0), "questions:bld_1", 10), false);
  assert.equal(await countUse(db(null), "questions:bld_1", 10), true);
  const counted = db(1);
  await countUse(counted, "questions:bld_1", 10);
  assert.equal(db.last.values[0], "questions:bld_1");
  assert.match(db.last.values[1], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(db.last.values[2], 10);
});
