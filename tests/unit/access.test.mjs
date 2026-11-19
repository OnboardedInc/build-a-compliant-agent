import { test } from "node:test";
import assert from "node:assert/strict";
import { wallOn, wallReady, sessionReady, verifyGoogleIdToken, signSession, readSession, SESSION_COOKIE, sessionCookie, clearSessionCookie } from "../../src/server/services/access.ts";

const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const [pair, otherPair] = await Promise.all([
  crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]),
  crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]),
]);
const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "test-key" };
const otherJwk = { ...await crypto.subtle.exportKey("jwk", otherPair.publicKey), kid: "rotated-key" };
const now = Date.UTC(2030, 0, 1);
const claims = { iss: "https://accounts.google.com", aud: "test-client", exp: now / 1000 + 3600, email_verified: true, hd: "EXAMPLE.COM", email: "QA@Example.COM" };
const options = { clientId: "test-client", domain: "example.com", now, keys: async () => [jwk] };
const encoded = (data) => Buffer.from(JSON.stringify(data)).toString("base64url");
async function token(changes = {}, header = {}, privateKey = pair.privateKey) {
  const input = `${encoded({ alg: "RS256", kid: jwk.kid, ...header })}.${encoded({ ...claims, ...changes })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}
const rejects = async (value, reason, opts = options) => assert.deepEqual(await verifyGoogleIdToken(value, opts), { ok: false, reason });

test("valid Google token returns the lower-cased email", async () => {
  assert.deepEqual(await verifyGoogleIdToken(await token(), options), { ok: true, email: "qa@example.com" });
});
test("accepts the other Google issuer, audience arrays, string true and case-insensitive domains", async () => {
  assert.deepEqual(await verifyGoogleIdToken(await token({ iss: "accounts.google.com", aud: ["another-client", "test-client"], email_verified: "true" }), { ...options, domain: "EXAMPLE.COM" }), { ok: true, email: "qa@example.com" });
});
for (const [name, changes, reason] of [
  ["wrong audience", { aud: "wrong-client" }, "audience"],
  ["wrong audience array", { aud: ["wrong-client"] }, "audience"],
  ["wrong issuer", { iss: "https://example.com" }, "issuer"],
  ["wrong hd", { hd: "other.example" }, "domain"],
  ["other email domain despite matching hd", { email: "qa@other.example" }, "domain"],
  ["missing hd", { hd: undefined }, "domain"],
  ["missing email", { email: undefined }, "domain"],
  ["malformed email", { email: "qa@extra@example.com" }, "domain"],
  ["unverified email", { email_verified: false }, "unverified"],
  ["string false", { email_verified: "false" }, "unverified"],
  ["missing verification", { email_verified: undefined }, "unverified"],
  ["expired token", { exp: now / 1000 - 61 }, "expired"],
  ["missing expiry", { exp: undefined }, "expired"],
  ["string expiry", { exp: String(now / 1000 + 3600) }, "expired"],
]) test(`rejects ${name}`, async () => rejects(await token(changes), reason));
test("allows less than 60 seconds of clock skew, rejecting the boundary", async () => {
  assert.equal((await verifyGoogleIdToken(await token({ exp: now / 1000 - 59 }), options)).ok, true);
  await rejects(await token({ exp: now / 1000 - 60 }), "expired");
});
test("rejects a signature from a different key", async () => rejects(await token({}, {}, otherPair.privateKey), "signature"));
test("rejects a tampered token payload", async () => {
  const parts = (await token()).split(".");
  parts[1] = encoded({ ...claims, email: "another@example.com" });
  await rejects(parts.join("."), "signature");
});
for (const alg of ["none", "HS256"]) test(`rejects ${alg}`, async () => rejects(await token({}, { alg }), "alg"));
test("rejects an unsigned alg none token as an algorithm failure", async () => rejects(`${encoded({ alg: "none" })}.${encoded(claims)}.`, "alg"));
test("rejects missing and unknown kid", async () => {
  await rejects(await token({}, { kid: undefined }), "kid");
  await rejects(await token({}, { kid: "unknown" }), "kid");
});
test("rejects malformed compact tokens and non-object JSON", async () => {
  for (const value of ["", "a.b", "a.b.c.d", "!.a.b", `${encoded(null)}.${encoded(claims)}.abc`, `${encoded({ alg: "RS256" })}.${encoded([])}.abc`]) await rejects(value, "malformed");
});
test("key lookup failures fail closed", async () => rejects(await token(), "keys", { ...options, keys: async () => { throw new Error("unavailable"); } }));
test("Google keys cache respects max-age, rotation, and the one-hour fallback without network", async (t) => {
  let clock = now, calls = 0;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs");
    calls += 1;
    return Response.json({ keys: calls === 1 ? [jwk] : [jwk, otherJwk] }, { headers: calls < 4 ? { "Cache-Control": "public, max-age=10" } : {} });
  });
  const defaults = { clientId: options.clientId, domain: options.domain, now };
  assert.equal((await verifyGoogleIdToken(await token(), defaults)).ok, true);
  assert.equal((await verifyGoogleIdToken(await token(), defaults)).ok, true);
  assert.equal(calls, 1);
  assert.equal((await verifyGoogleIdToken(await token({}, { kid: otherJwk.kid }, otherPair.privateKey), defaults)).ok, true);
  assert.equal(calls, 2);
  await rejects(await token({}, { kid: "unknown" }), "kid", defaults);
  assert.equal(calls, 3, "unknown cached kid triggers exactly one refresh");
  clock += 10_001;
  assert.equal((await verifyGoogleIdToken(await token(), defaults)).ok, true);
  assert.equal(calls, 4);
  clock += 3_599_999;
  assert.equal((await verifyGoogleIdToken(await token(), defaults)).ok, true);
  assert.equal(calls, 4);
  clock += 2;
  assert.equal((await verifyGoogleIdToken(await token(), defaults)).ok, true);
  assert.equal(calls, 5);
});

const secret = "unit-test-only-secret-".repeat(2);
test("a fresh session reads back the email and encodes the 12-hour expiry", async () => {
  const value = await signSession("QA@Example.COM", secret, now);
  assert.equal(await readSession(value, secret, now), "qa@example.com");
  assert.deepEqual(JSON.parse(Buffer.from(value.split(".")[0], "base64url")), { e: "qa@example.com", x: now / 1000 + 43200 });
});
test("session rejects a tampered payload", async () => {
  const value = await signSession("qa@example.com", secret, now);
  assert.equal(await readSession(`${encoded({ e: "another@example.com", x: now / 1000 + 43200 })}.${value.split(".")[1]}`, secret, now), null);
});
test("session rejects a tampered signature", async () => {
  const [payload, signature] = (await signSession("qa@example.com", secret, now)).split(".");
  assert.equal(await readSession(`${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`, secret, now), null);
});
test("session rejects expiry without clock skew", async () => {
  const value = await signSession("qa@example.com", secret, now, 1000);
  assert.equal(await readSession(value, secret, now + 999), "qa@example.com");
  assert.equal(await readSession(value, secret, now + 1000), null);
  assert.equal(await readSession(value, secret, now + 2000), null);
});
test("session rejects a different secret", async () => assert.equal(await readSession(await signSession("qa@example.com", secret, now), `${secret}different`, now), null));
test("session rejects malformed values", async () => {
  for (const value of [undefined, null, "", "a.b.c", "!.a", `${encoded(null)}.abc`]) assert.equal(await readSession(value, secret, now), null);
});
test("cookie helpers set and clear the host-only secure cookie", () => {
  assert.equal(SESSION_COOKIE, "__Host-bca_auth");
  assert.equal(sessionCookie("test-value"), "__Host-bca_auth=test-value; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200");
  assert.equal(clearSessionCookie(), "__Host-bca_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
});
test("wall toggles and readiness fail closed for missing configuration", () => {
  for (const env of [{}, { ACCESS_GOOGLE_DOMAIN: "" }, { ACCESS_GOOGLE_DOMAIN: " \t " }]) {
    assert.equal(wallOn(env), false);
    assert.equal(wallReady(env), false);
  }
  const env = { ACCESS_GOOGLE_DOMAIN: " example.com ", GOOGLE_CLIENT_ID: "test-client", SESSION_SECRET: secret };
  assert.equal(wallOn(env), true);
  assert.equal(wallReady(env), true);
  assert.equal(wallReady({ ...env, GOOGLE_CLIENT_ID: undefined }), false);
  assert.equal(wallReady({ ...env, GOOGLE_CLIENT_ID: " " }), false);
  assert.equal(wallReady({ ...env, SESSION_SECRET: undefined }), false);
  assert.equal(wallReady({ ...env, SESSION_SECRET: "x".repeat(31) }), false);
  assert.equal(wallReady({ ...env, SESSION_SECRET: "x".repeat(32) }), true);
  // Sessions need only the secret: without a client id nobody can sign in, so the wall stays shut.
  assert.equal(sessionReady({}), false);
  assert.equal(sessionReady({ ...env, GOOGLE_CLIENT_ID: undefined }), true);
  assert.equal(sessionReady({ ...env, SESSION_SECRET: undefined }), false);
  assert.equal(sessionReady({ ...env, SESSION_SECRET: "x".repeat(31) }), false);
});
