import assert from "node:assert/strict";
import { test } from "node:test";
import { basePath, route, stripBase, withBase } from "../../src/shared/base-path.ts";

const base = "/hiring-agent";

test("base paths normalize to a slash-prefixed path or the empty root", () => {
  for (const input of [undefined, "", "/", "///"]) assert.equal(basePath(input), "");
  for (const input of ["hiring-agent", base, "//hiring-agent//"]) assert.equal(basePath(input), base);
  assert.equal(basePath("tools//agent-2/"), "/tools/agent-2");
  for (const input of ["/Hiring", "/hiring_agent", "/../agent", "/hiring%2fagent", "/hiring agent", "/hiring?agent", "/hiring#agent", "/hiring\n", "https://example.test"]) {
    assert.throws(() => basePath(input), /BCA_BASE_PATH.*lowercase/);
  }
});

test("withBase prefixes root-relative paths and stripBase respects path boundaries", () => {
  for (const path of ["/", "/api/health", "/verify?token=example"]) {
    assert.equal(withBase("", path), path);
    assert.equal(withBase(base, path), `${base}${path}`);
  }
  assert.equal(stripBase("", "/call"), "/call");
  assert.equal(stripBase(base, base), "/");
  assert.equal(stripBase(base, `${base}/`), "/");
  assert.equal(stripBase(base, `${base}/api/health`), "/api/health");
  assert.equal(stripBase(base, `${base}-old/api/health`), null);
  assert.equal(stripBase(base, "/"), null);
});

test("root mode hands every path to Hono", () => {
  for (const path of ["/", "/api/health", "/questions", "/nothing-here"]) assert.deepEqual(route("", path), { kind: "hono" });
});

test("prefixed mode dispatches the SPA, both API paths, old links, and root pages", () => {
  assert.deepEqual(route(base, base), { kind: "redirect", to: `${base}/`, status: 308 });
  assert.deepEqual(route(base, `${base}/api/health`), { kind: "app-api", path: "/api/health" });
  assert.deepEqual(route(base, "/api/health"), { kind: "hono" });
  for (const path of ["/", "/questions", "/api-example", "/i/example"]) assert.deepEqual(route(base, `${base}${path}`), { kind: "app-page" });
  for (const path of ["/check-email", "/verify", "/questions", "/name", "/built", "/call", "/sign-in", "/i/example", "/Call/"]) {
    assert.deepEqual(route(base, path), { kind: "redirect", to: `${base}${path}`, status: 302 });
  }
  assert.deepEqual(route(base, "/"), { kind: "redirect", to: `${base}/`, status: 302 });
  for (const path of ["/nothing-here", "/i/", "/i/example/extra", `${base}-old/questions`]) assert.deepEqual(route(base, path), { kind: "root", status: 404 });
});
