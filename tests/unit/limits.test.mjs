import { test } from "node:test";
import assert from "node:assert/strict";
import { addressKey, countUse, countedAddress, MAX_AGENTS_PER_ADDRESS, MAX_REWRITES_PER_DAY } from "../../src/server/services/limits.ts";

test("the limits Sam set", () => {
  assert.equal(MAX_REWRITES_PER_DAY, 10);
  assert.equal(MAX_AGENTS_PER_ADDRESS, 10);
});

test("an address is counted under a salted hash, never itself", async () => {
  const key = await addressKey({ ADMIN_TOKEN: "salt" }, "203.0.113.9");
  assert.match(key, /^agents:[0-9a-f]{32}$/);
  assert.ok(!key.includes("203"));
  assert.equal(key, await addressKey({ ADMIN_TOKEN: "salt" }, " 203.0.113.9 "));
  assert.notEqual(key, await addressKey({ ADMIN_TOKEN: "other" }, "203.0.113.9"));
  assert.notEqual(key, await addressKey({ ADMIN_TOKEN: "salt" }, "203.0.113.10"));
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

test("local development has no address to count", () => {
  assert.equal(countedAddress(undefined), null);
  assert.equal(countedAddress(""), null);
  assert.equal(countedAddress("127.0.0.1"), null);
  assert.equal(countedAddress("::1"), null);
  assert.equal(countedAddress("::ffff:127.0.0.1"), null);
  assert.equal(countedAddress(" 203.0.113.9 "), "203.0.113.9");
  assert.equal(countedAddress("2001:DB8::1"), "2001:db8::1");
});
