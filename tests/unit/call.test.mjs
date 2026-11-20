import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CALL_SECONDS, callClock, endedAtLimit } from "../../src/shared/interview.ts";

test("a call is limited to twenty minutes", () => {
  assert.equal(MAX_CALL_SECONDS, 1200);
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

test("only a call that ran to the limit is said to have been ended by it", () => {
  assert.equal(endedAtLimit(600), false);
  assert.equal(endedAtLimit(1194), false);
  assert.equal(endedAtLimit(1195), true);
  assert.equal(endedAtLimit(1201), true);
});
