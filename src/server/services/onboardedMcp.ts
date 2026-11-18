// The Onboarded MCP server that AI Interview Agent 2 uses, and its MCP App.
//
// An MCP App is a tool whose result carries UI: the tool names a `ui://` resource, the host
// reads that resource (one HTML document) and shows it in a sandboxed frame, and passes it the
// tool's result over postMessage. Here the app is Onboarded's part of the candidate's screen:
// "Powered by Onboarded" and, under it, Onboarded's own hosted onboarding page in an iframe.
// The app never rebuilds a form: the link the agent created is shown as it is.
//
// Two MCP endpoints serve it (the JSON-RPC handling is in endpoints/sessions.ts):
//   /api/mcp/:sessionId                  the agent's tools, for an MCP client that holds the session's secret
//   /api/public/interviews/:token/mcp    the candidate's page, which is the app's host: show_forms only

export const MCP_PROTOCOL = "2025-06-18";
/** The MCP Apps protocol the view speaks with its host. */
const MCP_APPS_PROTOCOL = "2026-01-26";
export const FORM_APP_URI = "ui://onboarded/forms.html";
export const FORM_APP_MIME = "text/html;profile=mcp-app";

interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, { type: string; description: string }>; required?: string[] };
  _meta?: Record<string, unknown>;
}

/** A tool whose result the host shows in the form app. Both spellings of the key are in use. */
const withFormApp = { ui: { resourceUri: FORM_APP_URI, visibility: ["model", "app"] }, "ui/resourceUri": FORM_APP_URI };

/** What the form app is given to show: the tool result's structuredContent. */
export interface FormAppContent {
  /** Onboarded's hosted onboarding link for this hire. */
  url: string | null;
  done: number;
  total: number;
  allSet: boolean;
  candidateFirst: string;
  employer: string;
  startDay: string | null;
  site: string | null;
}

const SHOW_FORMS: McpTool = {
  name: "show_forms",
  title: "Show the onboarding forms",
  description:
    "The hire's onboarding forms, as Onboarded's hosted onboarding page. The result carries the hosted link and how many of the candidate's forms are done; the form app shows the page itself.",
  inputSchema: { type: "object", properties: {} },
  _meta: withFormApp,
};

const AGENT_TOOLS: McpTool[] = [
  {
    name: "get_requirements",
    title: "What a work site requires",
    description: "A dry run of the account's policies for one work site: the forms, what each is, why it applies and what to have ready. Saves nothing.",
    inputSchema: { type: "object", properties: { work_location: { type: "string", description: "The work site's name" } }, required: ["work_location"] },
  },
  {
    name: "request_offer",
    title: "Ask for the offer decision",
    description: "Whether the account's rule makes this candidate an offer now: OFFER, REVIEW, or MISSING with what to ask first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "start_paperwork",
    title: "Create the hire and open its forms",
    description: "After the candidate accepts: create the placement and its tasks in Onboarded and open the hosted onboarding page on the candidate's screen.",
    inputSchema: { type: "object", properties: {} },
    _meta: withFormApp,
  },
  {
    name: "read_form",
    title: "Read the form in hand",
    description: "What the candidate's current form says page by page, and what they have entered so far, without sensitive values.",
    inputSchema: { type: "object", properties: { form: { type: "string", description: "The form's name, if the candidate named one" } } },
  },
  SHOW_FORMS,
];

/** The agent's endpoint lists every tool; the candidate's page only the one it hosts. */
export const mcpTools = (scope: "agent" | "candidate"): McpTool[] => (scope === "agent" ? AGENT_TOOLS : [SHOW_FORMS]);

export const formAppResource = () => ({
  uri: FORM_APP_URI,
  name: "onboarded-forms",
  title: "Onboarded forms",
  description: "Onboarded's hosted onboarding page for one hire, inside the host's screen.",
  mimeType: FORM_APP_MIME,
});

/** The hosts the form app frames: Onboarded's own, read from the link the API returned. */
export const formAppMeta = (frameOrigin: string | null) => ({
  ui: {
    prefersBorder: false,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: frameOrigin ? [frameOrigin] : [] },
  },
});

const ICON =
  '<svg role="img" aria-label="Onboarded logo" width="16" height="16" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="109" fill="#14193D"></rect>' +
  '<path fill="#87EA5C" d="M465.23 341.16H159.89V256.79H518.03ZM592.3 341.16H526.91L579.72 256.79H645.1ZM714.06 341.16H648.67L701.48 256.79H766.86ZM835.82 341.16H770.43L823.24 256.79H888.63Z"></path>' +
  '<path fill="#87EA5C" d="M188.21,462.67c34.64-34.9,78.12-52.31,130.42-52.31s95.78,17.41,130.51,52.31c34.64,34.9,51.96,78.97,51.96,132.22s-17.32,97.32-51.96,132.22c-34.64,34.9-78.12,52.31-130.51,52.31s-95.78-17.41-130.42-52.31c-34.64-34.9-51.96-78.97-51.96-132.22s17.32-97.32,51.96-132.22ZM256.12,667.78c17.24,17.49,38.07,26.15,62.6,26.15s45.36-8.75,62.6-26.15c17.24-17.41,25.81-41.67,25.81-72.8s-8.57-55.39-25.81-72.8c-17.24-17.41-38.07-26.15-62.6-26.15s-45.36,8.75-62.6,26.15c-17.24,17.41-25.81,41.67-25.81,72.8s8.57,55.39,25.81,72.8Z"></path>' +
  '<path fill="#87EA5C" d="M737.27,408.76h0c-39.67,0-75.14,18-98.69,46.27v-38.02h-92.18v350.41h92.18v-201.96c0-37.82,30.66-68.49,68.49-68.49h0c37.82,0,68.49,30.66,68.49,68.49v201.96h90.14v-230.24c0-70.93-57.5-128.42-128.42-128.42Z"></path></svg>';

/**
 * The form app: one self-contained HTML document. It speaks the MCP Apps protocol with its
 * host over postMessage (ui/initialize, then tool results as notifications) and shows what
 * the tool result holds. No network of its own: the only thing it loads is the hosted link.
 */
export const formAppHtml = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Onboarded forms</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: #FFFFFF; color: #14193D; font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 13px 16px 11px; border-bottom: 1px solid #DEE2E6; }
  .powered { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #14193D; }
  .count { font-size: 12px; color: #606C79; white-space: nowrap; }
  main { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  iframe { flex: 1; min-height: 0; width: 100%; border: 0; background: #FFFFFF; }
  .note { margin: auto; padding: 24px; text-align: center; font-size: 14px; line-height: 1.5; color: #606C79; }
  .set { flex: 1; display: flex; flex-direction: column; gap: 14px; padding: 22px 18px 20px; overflow: auto; }
  .set h1 { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 700; }
  .set p { margin: 0; font-size: 15px; line-height: 1.5; color: #424B55; }
  .row { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border: 1px solid #DEE2E6; border-radius: 12px; }
  .row span { font-size: 12px; font-weight: 600; color: #606C79; }
  .row b { font-size: 16px; font-weight: 600; }
  .tick { width: 44px; height: 44px; border-radius: 50%; background: #E3F6E6; display: flex; align-items: center; justify-content: center; }
  button { margin-top: auto; height: 50px; border: 0; border-radius: 12px; background: #14193D; color: #FFFFFF; font: inherit; font-size: 16px; font-weight: 600; cursor: pointer; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <span class="powered">Powered by ${ICON} Onboarded</span>
  <span class="count" id="count" aria-live="polite"></span>
</header>
<main>
  <p class="note" id="wait">Opening your forms…</p>
  <iframe id="hosted" title="Your onboarding forms, from Onboarded" allow="camera; clipboard-write" hidden></iframe>
  <section class="set" id="set" data-testid="form-app-all-set" hidden>
    <div class="tick" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1F7A33" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg></div>
    <h1 id="set-title">You're all set for now</h1>
    <p id="set-text"></p>
    <div class="row" id="shift" hidden><span>Planned start date</span><b id="shift-day"></b><span id="shift-site"></span></div>
    <button type="button" id="done">Done</button>
  </section>
</main>
<script>
(function () {
  var host = window.parent;
  var nextId = 1;
  var waiting = {};
  var shown = null;
  function post(message) { host.postMessage(message, "*"); }
  function request(method, params) {
    return new Promise(function (resolve) { var id = nextId++; waiting[id] = resolve; post({ jsonrpc: "2.0", id: id, method: method, params: params }); });
  }
  function el(id) { return document.getElementById(id); }

  // What a tool result holds decides what is on screen: the hosted page, or the closing card.
  function render(data) {
    if (!data || typeof data !== "object") return;
    el("count").textContent = data.total ? data.done + " of " + data.total + " forms done" : "";
    var frame = el("hosted");
    if (data.allSet) {
      frame.hidden = true;
      el("wait").hidden = true;
      el("set").hidden = false;
      el("set-title").textContent = "You're all set for now" + (data.candidateFirst ? ", " + data.candidateFirst : "");
      el("set-text").textContent = (data.employer || "Your employer") + " confirms your start once it has finished its own steps. They may reach out if they need anything more from you.";
      el("shift").hidden = !data.startDay;
      el("shift-day").textContent = data.startDay || "";
      el("shift-site").textContent = data.site || "";
      return;
    }
    el("set").hidden = true;
    if (typeof data.url === "string" && /^https?:\\/\\//i.test(data.url) && data.url !== shown) {
      // Loaded once: reloading the link would start Onboarded's page over.
      shown = data.url;
      frame.src = data.url;
    }
    frame.hidden = !shown;
    el("wait").hidden = !!shown;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && m.method === undefined) {
      if (waiting[m.id]) { waiting[m.id](m.result); delete waiting[m.id]; }
      return;
    }
    if (m.method === "ui/notifications/tool-result") render(m.params && m.params.structuredContent);
    else if (m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} }); // ping, teardown
  });

  el("done").addEventListener("click", function () {
    request("ui/message", { role: "user", content: [{ type: "text", text: "Done" }] });
  });

  request("ui/initialize", { appInfo: { name: "Onboarded forms", version: "1.0.0" }, appCapabilities: {}, protocolVersion: "${MCP_APPS_PROTOCOL}" }).then(function () {
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  });
})();
</script>
</body>
</html>`;
