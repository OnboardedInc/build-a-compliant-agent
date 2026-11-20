import { test } from "node:test";
import assert from "node:assert/strict";
import { isHuman, turnstileOn, turnstileSiteKey } from "../../src/server/services/turnstile.ts";

const env = { TURNSTILE_SECRET: "secret", TURNSTILE_SITE_KEY: "site-key", TURNSTILE_HOSTNAMES: "agent.example, Other.Example " };
const answer = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const pass = { success: true, action: "start", hostname: "agent.example" };

test("Turnstile is off until the Worker has both keys", () => {
  assert.equal(turnstileOn({}), false);
  assert.equal(turnstileOn({ TURNSTILE_SECRET: "secret" }), false);
  assert.equal(turnstileOn({ TURNSTILE_SITE_KEY: "site-key" }), false);
  assert.equal(turnstileOn(env), true);
  assert.equal(turnstileSiteKey({ TURNSTILE_SITE_KEY: "site-key" }), null);
  assert.equal(turnstileSiteKey(env), "site-key");
});

test("a token passes only for its own action on a listed hostname", async () => {
  assert.equal(await isHuman(env, "token", "start", "203.0.113.9", answer(pass)), true);
  assert.equal(await isHuman(env, "token", "start", undefined, answer({ ...pass, hostname: "OTHER.example" })), true);
  assert.equal(await isHuman(env, "token", "lookup", undefined, answer(pass)), false);
  assert.equal(await isHuman(env, "token", "start", undefined, answer({ ...pass, hostname: "elsewhere.example" })), false);
  assert.equal(await isHuman(env, "token", "start", undefined, answer({ ...pass, hostname: undefined })), false);
});

test("the request to Cloudflare carries the secret, the token and the visitor's address", async () => {
  let sent;
  const fetcher = async (url, init) => { sent = { url, body: init.body, method: init.method }; return new Response(JSON.stringify(pass)); };
  await isHuman(env, "the-token", "start", "203.0.113.9", fetcher);
  assert.equal(sent.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(sent.method, "POST");
  assert.deepEqual(Object.fromEntries(sent.body), { secret: "secret", response: "the-token", remoteip: "203.0.113.9" });
});

test("everything unexpected is a refusal", async () => {
  let called = 0;
  const counted = async () => { called += 1; return new Response(JSON.stringify(pass)); };
  assert.equal(await isHuman(env, undefined, "start", undefined, counted), false);
  assert.equal(await isHuman(env, "", "start", undefined, counted), false);
  assert.equal(await isHuman(env, "x".repeat(2049), "start", undefined, counted), false);
  assert.equal(await isHuman({ ...env, TURNSTILE_HOSTNAMES: " " }, "token", "start", undefined, counted), false);
  assert.equal(await isHuman({ ...env, TURNSTILE_SECRET: "" }, "token", "start", undefined, counted), false);
  assert.equal(called, 0, "Cloudflare is not asked about a request that cannot pass");
  assert.equal(await isHuman(env, "token", "start", undefined, answer({ success: false, "error-codes": ["timeout-or-duplicate"] })), false);
  assert.equal(await isHuman(env, "token", "start", undefined, answer(pass, 500)), false);
  assert.equal(await isHuman(env, "token", "start", undefined, async () => new Response("not json")), false);
  assert.equal(await isHuman(env, "token", "start", undefined, async () => { throw new Error("network"); }), false);
});

test("Cloudflare's test secret is taken as it answers", async () => {
  const testing = { success: true, hostname: "example.com", metadata: { result_with_testing_key: true } };
  assert.equal(await isHuman(env, "XXXX.DUMMY.TOKEN.XXXX", "start", undefined, answer(testing)), true);
  assert.equal(await isHuman(env, "XXXX.DUMMY.TOKEN.XXXX", "start", undefined, answer({ ...testing, success: false })), false);
});
