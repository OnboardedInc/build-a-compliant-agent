import { useEffect, useRef, useState } from "react";
import type { CandidateFormApp } from "@shared/interview";

// Onboarded's form app on the candidate's screen. The app is an MCP App: a tool of the
// Onboarded MCP server (show_forms) names a `ui://` resource, and its result carries what the
// app shows. This component is the MCP host. It asks the server for the tool list, the
// resource and the tool's result over MCP (JSON-RPC on the candidate's own route), shows the
// resource in a sandboxed frame, and passes it the result over the MCP Apps postMessage
// protocol. What the frame shows is Onboarded's hosted onboarding page, as it is: this
// component never draws a form.

interface Rpc {
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ToolInfo {
  name: string;
  _meta?: { ui?: { resourceUri?: string }; "ui/resourceUri"?: string };
}

let rpcId = 0;

async function mcp<T>(token: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/public/interviews/${encodeURIComponent(token)}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = (await res.json().catch(() => null)) as Rpc | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error?.message ?? `The form app could not be loaded (${res.status}).`);
  return body.result as T;
}

/**
 * The frame's permissions. The hosted page is nested inside the app's frame and inherits
 * these, so it needs its own origin (the page keeps its session there), forms, and popups
 * for document links. Camera is for ID photos on the I-9.
 */
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";

export function FormApp({ token, app, onDone }: { readonly token: string; readonly app: CandidateFormApp; readonly onDone: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The view has finished the handshake and can be sent tool results.
  const [ready, setReady] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;

  // 1. As any MCP host would: find the tool that carries UI, and read its resource.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await mcp(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Build a Compliant Agent", version: "2.0.0" } });
        const { tools } = await mcp<{ tools: ToolInfo[] }>(token, "tools/list");
        const withUi = tools.find((t) => t._meta?.ui?.resourceUri ?? t._meta?.["ui/resourceUri"]);
        const uri = withUi?._meta?.ui?.resourceUri ?? withUi?._meta?.["ui/resourceUri"];
        if (!withUi || !uri) throw new Error("The Onboarded MCP server offered no form app.");
        const { contents } = await mcp<{ contents: Array<{ text?: string; _meta?: { ui?: { csp?: { frameDomains?: string[] } } } }> }>(token, "resources/read", { uri });
        const text = contents[0]?.text;
        if (!text) throw new Error("The form app's resource was empty.");
        if (cancelled) return;
        // The resource says which origins it frames. The host turns that into the app's
        // content security policy: its own inline script and style, and those frames, nothing else.
        const frames = (contents[0]?._meta?.ui?.csp?.frameDomains ?? []).filter((origin) => /^https?:\/\/[^\s'";]+$/.test(origin));
        const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src ${frames.length ? frames.join(" ") : "'none'"}">`;
        setTool(withUi.name);
        setHtml(text.replace("<head>", `<head>${csp}`));
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "The form app could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 2. The MCP Apps handshake with the view, and what the view asks of its host.
  useEffect(() => {
    if (html === null) return;
    const onMessage = (event: MessageEvent) => {
      const view = frame.current?.contentWindow;
      if (!view || event.source !== view) return;
      const m = event.data as { jsonrpc?: string; id?: number; method?: string; params?: Record<string, unknown> } | null;
      if (!m || m.jsonrpc !== "2.0" || m.method === undefined) return;
      const reply = (result: unknown) => view.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
      if (m.method === "ui/initialize") {
        reply({
          protocolVersion: (m.params?.protocolVersion as string | undefined) ?? "2026-01-26",
          hostInfo: { name: "Build a Compliant Agent", version: "2.0.0" },
          hostCapabilities: { message: {}, openLinks: {} },
          hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline"], platform: "web", locale: navigator.language },
        });
      } else if (m.method === "ui/notifications/initialized") {
        setReady(true);
      } else if (m.method === "ui/message") {
        // The app's only message is its Done button.
        reply({});
        done.current();
      } else if (m.method === "ui/open-link") {
        const url = m.params?.url;
        if (typeof url === "string" && /^https?:\/\//.test(url)) window.open(url, "_blank", "noopener");
        reply({});
      } else if (m.id !== undefined) {
        view.postMessage({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Not supported by this host: ${m.method}` } }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [html]);

  // 3. Call the tool and hand its result to the view: at first, and again when the count moves.
  useEffect(() => {
    if (!ready || tool === null) return;
    let cancelled = false;
    void mcp<ToolResult>(token, "tools/call", { name: tool, arguments: {} })
      .then((result) => {
        const view = frame.current?.contentWindow;
        if (cancelled || !view) return;
        view.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } }, "*");
        view.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result }, "*");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "The forms could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [ready, tool, token, app.url, app.done, app.total, app.allSet]);

  if (error) {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[14px] text-[#424B55]" data-testid="form-app-error">
        <p>{error}</p>
        <a href={app.url} target="_blank" rel="noreferrer" className="rounded-lg bg-[#14193D] px-4 py-2.5 text-[14px] font-semibold text-white">
          Open your forms in a new tab
        </a>
      </div>
    );
  }
  if (html === null) {
    return <div className="flex h-full items-center justify-center text-[14px] text-[#606C79]">Opening your forms…</div>;
  }
  return (
    <iframe
      ref={frame}
      title="Onboarded forms"
      data-testid="form-app"
      data-ready={ready}
      sandbox={SANDBOX}
      allow="camera; clipboard-write"
      srcDoc={html}
      className="block h-full w-full border-0 bg-white"
    />
  );
}
