import { test } from "node:test";
import assert from "node:assert/strict";
import { announceBuiltAgent, builtAgentMessage } from "../../src/server/services/notify.ts";

const agent = { email: "priya@larkspur.example", contactName: "Priya Shah", contactTitle: "Operations lead", company: "Larkspur <Staffing> & Co", website: "larkspur.example", primary: "#14193D", secondary: "#FCAC84", agentName: "Juno", agentFace: 3, jobTitle: "Banquet server", description: "Servers for hotel events.", questions: ["Have you served at events?", "Can you work weekends?"] };

test("the message says who built what, in Slack's plain text", () => {
  const text = builtAgentMessage("example.com", agent);
  assert.match(text, /^\*New agent built on example\.com\*/);
  assert.ok(text.includes("*Who:* priya@larkspur.example (Priya Shah, Operations lead)"));
  assert.ok(text.includes("*Company:* Larkspur &lt;Staffing&gt; &amp; Co (larkspur.example)"));
  assert.ok(text.includes("*Agent:* Juno, face 3, colours #14193D and #FCAC84"));
  assert.ok(text.includes("*Question 1:* Have you served at events?"));
  assert.ok(text.includes("*Question 2:* Can you work weekends?"));
  assert.ok(text.includes("*Their description:* Servers for hotel events."));
});

test("a builder with no name or job title on file is still announced", () => {
  const text = builtAgentMessage("example.com", { ...agent, contactName: null, contactTitle: null });
  assert.ok(text.includes("*Who:* priya@larkspur.example\n"));
});

test("nothing is sent without a Slack webhook, or to an address that is not Slack's", async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return new Response("ok"); };
  assert.equal(await announceBuiltAgent({ SITE_NAME: "example.com" }, agent, fetcher), false);
  assert.equal(await announceBuiltAgent({ SITE_NAME: "example.com", SLACK_WEBHOOK_URL: "https://example.org/hook" }, agent, fetcher), false);
  assert.equal(calls, 0);
});

test("the message is posted to the webhook, and a failure is swallowed", async () => {
  let sent;
  const env = { SITE_NAME: "example.com", SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/example" };
  assert.equal(await announceBuiltAgent(env, agent, async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response("ok"); }), true);
  assert.equal(sent.url, env.SLACK_WEBHOOK_URL);
  assert.match(sent.body.text, /New agent built/);
  assert.equal(await announceBuiltAgent(env, agent, async () => new Response("no", { status: 500 })), false);
  assert.equal(await announceBuiltAgent(env, agent, async () => { throw new Error("network"); }), false);
});
