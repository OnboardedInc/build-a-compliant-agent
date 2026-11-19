import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuestions } from "../../src/server/services/questionFormat.ts";

const answer = (topic1 = "Experience", extra = "") => `job_title: Payroll specialist
q1: Can you describe your experience running multi-state payroll for at least two years?
q1_topic: ${topic1}
q1_listen_for: At least two years of multi-state payroll, with details.
${extra}q2: Are you able to work on site Monday through Friday every week?
q2_topic: Schedule availability
q2_listen_for: A clear yes to on site, Monday to Friday.`;

test("reads the seven lines", () => {
  const out = parseQuestions(answer());
  assert.equal(out.jobTitle, "Payroll specialist");
  assert.deepEqual(out.questions.map((q) => q.topic), ["Experience", "Schedule availability"]);
});
test("a topic of three words is cut to two instead of refused", () => {
  assert.equal(parseQuestions(answer("Multi-state payroll experience")).questions[0].topic, "Multi-state payroll");
});
test("blank lines and markdown marks are ignored", () => {
  assert.ok(parseQuestions(answer("Experience", "\n")));
  assert.ok(parseQuestions(answer().split("\n").map((line) => `- **${line.replace(": ", ":** ")}`).join("\n")));
});
test("a missing line, a repeated line and a long question are refused", () => {
  assert.equal(parseQuestions(answer().split("\n").slice(1).join("\n")), null);
  assert.equal(parseQuestions(`${answer()}\nq2: Again, are you able to work on site?`), null);
  assert.equal(parseQuestions(answer().replace("Are you able", `Are you ${"really ".repeat(30)}able`)), null);
  assert.equal(parseQuestions("Sure! Here are two questions."), null);
});
test("a cut topic does not end on a joining word", () => {
  assert.equal(parseQuestions(answer("Go and Postgres")).questions[0].topic, "Go");
});
