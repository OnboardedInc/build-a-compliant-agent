import { useCallback, useEffect, useRef, useState } from "react";
import type Vapi from "@vapi-ai/web";
import type { InterviewEvents, InterviewMode, InterviewStatus, TranscriptLine, VoiceJoin, VoiceSettings } from "@shared/interview";
import { endedAtLimit } from "@shared/interview";
import { errorMessage } from "./useSession";

/** What a call needs from its session: the studio's controller, or the candidate's own page. */
export interface VoiceLine {
  /** A caller that follows its own journey can schedule its own reads. */
  poll?: false;
  session: { mode: InterviewMode; status: InterviewStatus; callSeconds: number; linkToken?: string | null };
  current: { current: { id: string } };
  events(body: InterviewEvents): Promise<unknown>;
  refresh(): Promise<unknown>;
  report(reason: unknown): void;
}

/** Where the voice settings and the call come from. The studio's routes by default. */
export interface VoiceApi {
  settings(): Promise<VoiceSettings>;
  join(): Promise<VoiceJoin>;
}

function voiceErrorMessage(reason: unknown): string {
  if (typeof reason === "object" && reason !== null) {
    if ("message" in reason && typeof reason.message === "string") return reason.message;
    if ("error" in reason) return voiceErrorMessage(reason.error);
  }
  return errorMessage(reason);
}

export function useVoiceCall(controller: VoiceLine, api: VoiceApi) {
  const { session, current, events, refresh, report } = controller;
  const source = useRef(api);
  source.current = api;
  const enabled = session.mode === "live";
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [active, setActive] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  /** The last call was ended by the call length limit, not by anyone on it. */
  const [limitReached, setLimitReached] = useState(false);
  const [partial, setPartial] = useState<TranscriptLine | null>(null);
  const [seconds, setSeconds] = useState(session.callSeconds);
  const vapi = useRef<Vapi | null>(null);
  const alive = useRef(true);
  const joining = useRef(false);
  const started = useRef(0);
  const sequence = useRef(0);
  /** When the interviewer last began to speak, to tell whether she answered a resume. */
  const spokeAt = useRef(0);
  /** The interviewer's last finished line, so a resume can repeat a question that was left open. */
  const lastSaid = useRef("");

  useEffect(() => {
    alive.current = true;
    if (enabled) {
      void source.current.settings()
        .then(value => { if (alive.current) setSettings(value); })
        .catch(reason => { if (alive.current) setSettingsError(errorMessage(reason)); });
    }
    return () => {
      alive.current = false;
      const client = vapi.current;
      if (client) {
        client.removeAllListeners();
        void client.stop().catch(() => {});
        vapi.current = null;
      }
    };
  }, [enabled]);

  useEffect(() => {
    // A session with a candidate link is also watched before the call: the candidate starts it elsewhere.
    const waiting = session.status === "idle" && !!session.linkToken;
    if (controller.poll === false || !enabled || (!active && session.status !== "live" && !waiting)) return;
    const every = waiting && !active ? 2500 : 1000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); } catch (reason) { if (!stopped) report(reason); }
      if (!stopped) timer = setTimeout(poll, every);
    };
    timer = setTimeout(poll, every);
    return () => { stopped = true; clearTimeout(timer); };
  }, [controller.poll, enabled, active, session.status, session.linkToken, refresh, report]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started.current) / 1000)), 250);
    return () => clearInterval(timer);
  }, [active]);

  const start = useCallback(async () => {
    if (!enabled || joining.current || vapi.current || !settings?.configured) return;
    joining.current = true;
    setConnecting(true);
    setError(null);
    setMuted(false);
    setPaused(false);
    setLimitReached(false);
    setPartial(null);
    started.current = 0;
    try {
      // The package is CommonJS: depending on the bundler its class is the default export or one level under it.
      const loaded = (await import("@vapi-ai/web")) as unknown as { default: typeof Vapi | { default: typeof Vapi } };
      const VapiClient = typeof loaded.default === "function" ? loaded.default : loaded.default.default;
      const join = await source.current.join();
      if (!alive.current) return;
      const client = new VapiClient("", undefined, { avoidEval: true });
      vapi.current = client;
      const send = (body: Parameters<typeof events>[0]) => {
        void events(body).catch(report);
      };
      client.on("call-start", () => {
        if (!alive.current) return;
        started.current = Date.now();
        setSeconds(0);
        setActive(true);
        setConnecting(false);
        send({ call: "start" });
      });
      client.on("speech-start", () => { spokeAt.current = Date.now(); if (alive.current) setSpeaking(true); });
      client.on("speech-end", () => { if (alive.current) setSpeaking(false); });
      client.on("message", (message: unknown) => {
        if (!alive.current || typeof message !== "object" || message === null) return;
        const m = message as Record<string, unknown>;
        if (m.type === "tool-calls-result") void refresh().catch(report);
        if (m.type !== "transcript" || typeof m.transcript !== "string") return;
        const line: TranscriptLine = {
          id: `live-${Date.now()}-${sequence.current++}`,
          at: started.current ? Math.floor((Date.now() - started.current) / 1000) : 0,
          who: m.role === "assistant" ? "ai" : "candidate", text: m.transcript,
        };
        if (m.transcriptType === "final") {
          if (line.who === "ai") lastSaid.current = line.text;
          setPartial(null);
          send({ lines: [line], callSeconds: line.at });
        } else setPartial(line);
      });
      client.on("call-end", () => {
        if (!alive.current) return;
        const callSeconds = started.current ? Math.floor((Date.now() - started.current) / 1000) : 0;
        setActive(false);
        setConnecting(false);
        setSpeaking(false);
        setPaused(false);
        setPartial(null);
        setSeconds(callSeconds);
        setLimitReached(endedAtLimit(callSeconds));
        send({ call: "end", callSeconds });
        client.removeAllListeners();
        vapi.current = null;
      });
      client.on("error", (reason: unknown) => {
        if (!alive.current) return;
        setError(voiceErrorMessage(reason));
      });
      await client.reconnect({ id: join.callId, webCallUrl: join.webCallUrl,
        ...(join.callToken ? { transport: { callToken: join.callToken } } : {}) });
    } catch (reason) {
      if (alive.current) {
        setError(voiceErrorMessage(reason));
        const client = vapi.current;
        client?.removeAllListeners();
        if (client) void client.stop().catch(() => {});
        vapi.current = null;
        setActive(false);
      }
    } finally {
      joining.current = false;
      if (alive.current) setConnecting(false);
    }
  }, [enabled, settings, current, events, refresh, report]);

  const mute = useCallback(() => {
    if (!vapi.current) return;
    vapi.current.setMuted(!muted);
    setMuted(!muted);
  }, [muted]);
  const stop = useCallback(() => { void vapi.current?.stop().catch(report); }, [report]);

  // Pause keeps the call connected and closes both directions: the microphone is muted and so
  // is the interviewer's voice. The interviewer is told through a system message, and on resume
  // is asked to welcome the candidate back. Vapi has no pause of its own, so the call's minutes
  // keep running.
  const pause = useCallback(() => {
    const client = vapi.current;
    if (!client) return;
    const next = !paused;
    try {
      if (next) {
        client.send({ type: "add-message", triggerResponseEnabled: false, message: { role: "system",
          content: "[Onboarded] The candidate paused the call. They cannot hear you and you cannot hear them until they resume. Say nothing." } });
        client.send({ type: "control", control: "mute-assistant" });
        client.setMuted(true);
        setSpeaking(false);
        setPartial(null);
      } else {
        client.send({ type: "control", control: "unmute-assistant" });
        client.setMuted(muted);
        // Sent as the candidate's turn: a system message at the end of the conversation did not
        // always get a reply (one test call in three stayed silent).
        const at = Date.now();
        client.send({ type: "add-message", triggerResponseEnabled: true, message: { role: "user",
          content: "[Onboarded] The candidate paused the call and has now resumed it. Welcome them back in a few words. If you were waiting for their answer to a question, ask it again in one sentence. If they are filling in forms, say only that you are still on the line." } });
        // If she still says nothing, the candidate is told the call is back in fixed words. When
        // her last words were a question (the interview was waiting on an answer), it is asked again.
        const open = lastSaid.current.trim().match(/[^.?!]*\?$/)?.[0]?.trim();
        setTimeout(() => {
          if (vapi.current === client && spokeAt.current < at) client.say(open ? `Welcome back. ${open}` : "Welcome back. I'm still on the line.");
        }, 6000);
      }
      setPaused(next);
    } catch (reason) {
      report(reason);
    }
  }, [paused, muted, report]);

  return { settings, settingsError, error, connecting, active, speaking, muted, paused, limitReached, partial,
    seconds: active ? seconds : session.callSeconds, start, mute, pause, stop };
}

export type VoiceCall = ReturnType<typeof useVoiceCall>;
