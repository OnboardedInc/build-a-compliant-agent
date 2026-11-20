import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CALL_SECONDS, MAX_CONNECTED_SECONDS, activeSeconds, callClock, endedAtLimit } from "../../src/shared/interview.ts";

test("a call is limited to twenty minutes on the call, and thirty connected", () => {
  assert.equal(MAX_CALL_SECONDS, 1200);
  assert.equal(MAX_CONNECTED_SECONDS, 1800);
});

test("the clock stops while the call is paused", () => {
  const start = 1_000_000;
  assert.equal(activeSeconds(start + 65_000, start, 0, null), 65);
  // Paused at 1:05 and still paused two minutes later: the clock still reads 1:05.
  assert.equal(activeSeconds(start + 185_000, start, 0, start + 65_000), 65);
  // Resumed after those two minutes, then thirty more seconds on the call.
  assert.equal(activeSeconds(start + 215_000, start, 120_000, null), 95);
  // A second pause, on top of the first.
  assert.equal(activeSeconds(start + 300_000, start, 120_000, start + 215_000), 95);
  assert.equal(activeSeconds(start, start + 500, 0, null), 0);
});

test("the clock counts up, then counts down the last two minutes", () => {
  assert.equal(callClock(0), "0:00");
  assert.equal(callClock(65), "1:05");
  assert.equal(callClock(1079), "17:59");
  assert.equal(callClock(1080), "2:00 left");
  assert.equal(callClock(1199), "0:01 left");
  assert.equal(callClock(1200), "0:00 left");
  assert.equal(callClock(1203), "0:00 left");
});

test("only a call connected to Vapi's ceiling is said to have been cut by it", () => {
  assert.equal(endedAtLimit(1200), false);
  assert.equal(endedAtLimit(1794), false);
  assert.equal(endedAtLimit(1795), true);
  assert.equal(endedAtLimit(1801), true);
});
