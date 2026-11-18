// Part of `npm run dev:voice`. Vapi runs Ava in its cloud, and when she checks
// requirements mid-call Vapi posts to this app and waits for the answer. Vapi cannot
// reach localhost, so this opens a cloudflared tunnel to the local API (port 8788) and
// saves the tunnel's address in settings.public_url. The address is cleared again on exit.
//
// While this runs, the local API is reachable from the internet at a random address.
// Every route still needs the app token, or a call's own secret for the tool webhook.
// A deployed Worker does not need any of this: it uses its own address.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const API = "http://localhost:8788/api";
const vars = await readFile(new URL("../.dev.vars", import.meta.url), "utf8").catch(() => "");
const configured = vars.match(/^\s*(?:export\s+)?ADMIN_TOKEN\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\r\n]*))/m);
const TOKEN = process.env.ADMIN_TOKEN || (configured?.[1] ?? configured?.[2] ?? configured?.[3] ?? "").trim();
if (!TOKEN) { console.error("Set ADMIN_TOKEN in .dev.vars before starting the voice tunnel."); process.exit(1); }
// cloudflared's own status page. The app asks it whether the tunnel is still up
// (src/server/endpoints/sessions.ts uses the same port).
const STATUS = "127.0.0.1:20248";
const say = (text) => console.log(text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Save this product's public address with its admin credential.
const save = (url) => fetch(`${API}/admin/public-url`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ url }),
  signal: AbortSignal.timeout(5000),
});

const tunnel = spawn("cloudflared", ["tunnel", "--url", "http://localhost:8788", "--no-autoupdate", "--metrics", STATUS], {
  stdio: ["ignore", "pipe", "pipe"],
});
tunnel.on("error", (e) => {
  say(e.code === "ENOENT" ? "cloudflared is not installed. Install it with: brew install cloudflared" : `cloudflared failed: ${e.message}`);
  process.exit(1);
});

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  tunnel.kill();
  // The API may already be shutting down with us; a later start overwrites the address anyway.
  await save(null).catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
tunnel.on("exit", (code) => {
  if (!stopping) {
    say(`the tunnel stopped (exit ${code}). Live calls will not reach this machine until it is restarted.`);
    void save(null).catch(() => {}).then(() => process.exit(1));
  }
});

// cloudflared prints the public address in its log.
const url = await new Promise((resolve) => {
  let log = "";
  const read = (chunk) => {
    log += chunk.toString();
    const found = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (found) resolve(found[0]);
  };
  tunnel.stdout.on("data", read);
  tunnel.stderr.on("data", read);
});

// Wait for the API (wrangler starts beside us) and for the tunnel to connect. The tunnel's
// address is not looked up from here: asking for it before its DNS exists makes macOS
// remember "no such host" for a while.
const until = async (what, check, seconds) => {
  for (let i = 0; i < seconds * 2; i += 1) {
    if (await check().catch(() => false)) return true;
    await sleep(500);
  }
  say(`${what} did not answer after ${seconds} s.`);
  return false;
};
const apiUp = async () => (await fetch(`${API}/health`, { signal: AbortSignal.timeout(3000) })).ok;
const connected = async () => {
  const ready = await (await fetch(`http://${STATUS}/ready`, { signal: AbortSignal.timeout(3000) })).json();
  return ready.readyConnections >= 1;
};
if (!(await until("The local API on port 8788", apiUp, 90))) await stop();
if (!(await until("The tunnel", connected, 45))) await stop();

const saved = await save(url).catch(() => null);
if (!saved?.ok) {
  say(`could not save the tunnel address (${saved ? saved.status : "no answer"}). Check ADMIN_TOKEN in .dev.vars and restart this command.`);
} else {
  say(`tunnel is up: ${url}`);
  say("saved as the public URL for tool calls. Start a live call at http://localhost:5176/call");
  say("this machine's API is reachable at that address until you stop this command (Ctrl-C).");
}
