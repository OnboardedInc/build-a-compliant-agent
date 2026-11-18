import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronsDownIcon, ChevronsUpIcon, Loader2, MicIcon, MicOffIcon, PauseIcon, PhoneOffIcon, PlayIcon } from "lucide-react";
import { formatClock, localToday, type CandidateInterview, type InterviewEvents, type JourneyStage, type VoiceJoin } from "@shared/interview";
import { useVoiceCall, type VoiceApi, type VoiceCall, type VoiceLine } from "./useVoiceCall";
import { errorMessage } from "./useSession";
import { AgentFace } from "../AgentFace";
import { CompanyLogo } from "../build/PhonePreview";
import type { CSSProperties } from "react";
import { FormApp } from "./FormApp";
import "./agent2.css";

const stages = ["screen", "offer", "forms", "ready"] as const;
const labels = ["Screen", "Offer", "Forms", "Ready"];

function JourneyBar({ stage, compact = false }: { stage: JourneyStage | null; compact?: boolean }) {
  const current = Math.max(0, stages.indexOf(stage ?? "screen"));
  return <ol aria-label="Steps from screening to ready for work" className={`a2-journey ${compact ? "compact" : ""}`}>
    {stages.map((id, i) => <li key={id} aria-current={i === current ? "step" : undefined} className={i <= current ? "filled" : ""}>
      <span className="a2-step-bar" /><span>{labels[i]}</span>
    </li>)}
  </ol>;
}

function Wave({ speaking, compact = false }: { speaking: boolean; compact?: boolean }) {
  const heights = compact ? [8, 16, 24, 14, 8] : [10, 18, 28, 40, 24, 14, 32, 44, 30, 18, 12, 22, 36, 26, 12];
  return <div aria-hidden="true" className={`a2-wave ${compact ? "compact" : ""}`}>
    {heights.map((height, i) => <span key={i} className={speaking ? "motion-safe:animate-wave" : ""} style={{ height: speaking ? height : 4, animationDelay: `${i % 7 * 0.11}s` }} />)}
  </div>;
}

function CallButtons({ voice, compact = false }: { voice: VoiceCall; compact?: boolean }) {
  const size = compact ? 18 : 26;
  return <div className={`a2-call-buttons ${compact ? "compact" : ""}`}>
    <div><button type="button" aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={voice.muted} disabled={voice.paused} onClick={voice.mute} className={voice.muted ? "muted" : ""}>
      {voice.muted ? <MicOffIcon size={size} /> : <MicIcon size={size} />}
    </button>{!compact && <span>{voice.muted ? "Unmute" : "Mute"}</span>}</div>
    <div><button type="button" data-testid="candidate-pause" aria-label={voice.paused ? "Resume the call" : "Pause the call"} aria-pressed={voice.paused} onClick={voice.pause} className={voice.paused ? "paused" : ""}>
      {voice.paused ? <PlayIcon size={size} /> : <PauseIcon size={size} />}
    </button>{!compact && <span>{voice.paused ? "Resume" : "Pause"}</span>}</div>
    <div><button type="button" aria-label="End call" onClick={voice.stop} className="end"><PhoneOffIcon size={size} /></button>{!compact && <span>End call</span>}</div>
  </div>;
}

export function AgentCall({ token, initial, onBusyChange }: { token: string; initial: CandidateInterview; onBusyChange?: (busy: boolean) => void }) {
  const [info, setInfo] = useState(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [last, setLast] = useState({ ai: "", candidate: "" });
  const [closed, setClosed] = useState(false);
  const [scale, setScale] = useState(1);
  // The form at full height: the caption and the steps are put away, the call bar stays.
  const [wide, setWide] = useState(false);
  const words = useRef<HTMLParagraphElement>(null);
  const alive = useRef(true);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const base = `/api/public/interviews/${encodeURIComponent(token)}`;

  useEffect(() => {
    alive.current = true;
    const resize = () => setScale(window.innerWidth >= 600 ? Math.min(1, (window.innerHeight - 32) / 800) : 1);
    resize();
    window.addEventListener("resize", resize);
    return () => { alive.current = false; window.removeEventListener("resize", resize); };
  }, []);

  // Serialize reads with events so an older poll cannot replace a new journey stage.
  const request = useCallback(<T,>(path = "", body?: unknown): Promise<T> => {
    const run = queue.current.catch(() => {}).then(async () => {
      const res = await fetch(`${base}${path}`, path ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
      if (!res.ok) {
        const value = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(value?.error ?? `Something went wrong (${res.status}). Please try again.`);
      }
      return await res.json() as T;
    });
    queue.current = run;
    return run;
  }, [base]);
  const adopt = useCallback((next: CandidateInterview) => {
    if (alive.current) { setInfo(next); setNotice(null); }
  }, []);
  const read = useCallback(async () => { adopt(await request<CandidateInterview>()); }, [request, adopt]);
  const report = useCallback((reason: unknown) => { if (alive.current) setNotice(errorMessage(reason)); }, []);
  const events = useCallback(async (body: InterviewEvents) => {
    for (const said of body.lines ?? []) setLast(previous => ({ ...previous, [said.who]: said.text }));
    adopt(await request<CandidateInterview>("/events", body));
  }, [request, adopt]);
  const line = useMemo<VoiceLine>(() => ({
    session: { mode: "live", status: info.state === "ready" ? "idle" : info.state === "live" ? "live" : "ended", callSeconds: 0 },
    current: { current: { id: token } }, events, refresh: read, report, poll: false,
  }), [info.state, token, events, read, report]);
  const api = useMemo<VoiceApi>(() => ({
    settings: async () => ({ enabled: true, configured: initial.voiceReady, keyHint: null, orgId: null, toolBaseUrl: null }),
    join: () => request<VoiceJoin>("/call", { today: localToday() }),
  }), [initial.voiceReady, request]);
  const voice = useVoiceCall(line, api);
  useEffect(() => { onBusyChange?.(voice.active || voice.connecting || info.state === "live"); }, [voice.active, voice.connecting, info.state, onBusyChange]);
  const every = closed ? null : voice.active || voice.connecting || info.state === "live" || (info.formApp && !info.formApp.allSet) ? 2000
    : !info.formApp && (info.state === "done" || info.state === "offer") ? 4000 : null;
  useEffect(() => {
    if (every === null) return;
    let stopped = false;
    let reading = false;
    const timer = setInterval(() => {
      if (reading) return;
      reading = true;
      void read().catch(reason => { if (!stopped) report(reason); }).finally(() => { reading = false; });
    }, every);
    return () => { stopped = true; clearInterval(timer); };
  }, [every, read, report]);

  const PAUSED = `The call is paused. ${info.agentName} cannot hear you. Press play to carry on.`;
  const face = (size = 108) => <AgentFace face={info.agentFace} size={size} head={info.brand.secondary} eye={info.brand.primary} />;
  const ava = voice.partial?.who === "ai" ? voice.partial.text : last.ai;
  const candidate = voice.partial?.who === "candidate" ? voice.partial.text : last.candidate;
  // Vapi reports the room closing as an error when Ava ends the call herself: once the call is
  // over that is not something to show the candidate.
  const callError = voice.active || voice.connecting || info.state === "ready" ? voice.error : null;
  const error = notice ?? callError ?? voice.settingsError;
  const finished = !voice.active && !voice.connecting && (info.state === "done" || info.state === "offer");
  const done = () => { if (voice.active) voice.stop(); setClosed(true); };
  // The caption has a fixed height, so the form under it never moves: keep its newest words in view.
  useEffect(() => {
    const node = words.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [ava, voice.paused, wide]);

  return <main className="a2-candidate" style={{ "--agent-primary": info.brand.primary, "--agent-secondary": info.brand.secondary } as CSSProperties} data-testid="candidate-call"
    data-state={voice.active ? "live" : voice.connecting ? "connecting" : info.state} data-stage={info.stage ?? ""}
    data-forms={info.formApp ? `${info.formApp.done}/${info.formApp.total}` : ""}>
    <div className="a2-phone-space" style={{ width: 372 * scale, height: 800 * scale }}>
      <div className="a2-phone" style={{ transform: `scale(${scale})` }}>
        <div className="a2-company-brand"><CompanyLogo brand={info.brand} company={info.employer} size={28} /><div><strong>{info.employer}</strong><span>{info.jobTitle}</span></div></div>
        {closed || (finished && !info.formApp) ? <div className="a2-farewell" data-testid={closed ? "agent2-closed" : "candidate-done"}>
          {face()}<h1>{closed ? `You're all set${info.candidateFirst ? `, ${info.candidateFirst}` : ""}.` : `Thanks${info.candidateFirst ? `, ${info.candidateFirst}` : ""}.`}</h1>
          <p>{closed ? `${info.employer} will confirm your start. You can close this page.` : `That's the interview. The team at ${info.employer} is reviewing it and will get back to you. You can close this page.`}</p>
        </div> : info.formApp ? <>
          <div className="a2-compact-bar">{face(40)}<div className="a2-compact-name"><b>{info.agentName}</b><span>{voice.active ? <>{voice.paused ? "Paused" : voice.speaking ? "Talking" : "On call"} · <time>{formatClock(voice.seconds)}</time></> : `${info.agentName} has left the call`}</span></div>
            {voice.active && <><Wave compact speaking={voice.speaking && !voice.paused} /><CallButtons compact voice={voice} /></>}
          </div>
          {!wide && <JourneyBar stage="forms" compact />}
          {/* A fixed height, whatever Ava says: the form below must not move. With no call on this screen and nothing said, it is left out. */}
          {!wide && (voice.active || ava) && <div className="a2-form-caption" data-testid="agent2-caption"><div className="a2-caption">
            <div className="a2-caption-head"><b>{info.agentName}</b>{voice.active && !voice.paused && !voice.speaking && !info.formApp.allSet && <span className="a2-wait">Waiting while you fill it in</span>}{voice.paused && <span className="a2-wait">Paused</span>}</div>
            <p ref={words} aria-live="polite">{voice.paused ? PAUSED : ava}</p>
          </div></div>}
          {error && <p role="alert" className="a2-error">{error}</p>}
          <div className="a2-sheet-toggle"><button type="button" data-testid="agent2-expand" aria-pressed={wide} onClick={() => setWide(!wide)}>{wide ? <ChevronsDownIcon size={14} /> : <ChevronsUpIcon size={14} />}{wide ? "Show captions" : "Expand form"}</button></div>
          <section className="a2-form-sheet" aria-label="Onboarded form app" data-testid="agent2-form-sheet"><FormApp token={token} app={info.formApp} onDone={done} /></section>
        </> : voice.active ? <>
          <div className="a2-call-heading"><div><span>{info.employer}</span><b>{info.jobTitle}</b></div><span className={`a2-live ${voice.paused ? "paused" : ""}`}>{voice.paused ? "Paused" : <><i />Live</>}</span></div>
          <JourneyBar stage={info.stage} />
          <div className="a2-screening"><div className="a2-identity">{face()}<h1>{info.agentName}</h1><p>AI interviewer for {info.employer}</p><time>{formatClock(voice.seconds)}</time></div>
            <Wave speaking={voice.speaking && !voice.paused} />
            <div className="a2-caption a2-screen-caption" aria-live="polite">{voice.paused ? <div><b>Paused</b><p>{PAUSED}</p></div> : <>{candidate && <div className="a2-you"><b>You</b><p>{candidate}</p></div>}<div><b>{info.agentName}{info.stage === "screen" && ` · question ${info.questionNow} of ${info.questionCount}`}</b><p>{ava || `Connected. ${info.agentName} will speak first.`}</p></div></>}</div>
          </div>
          {error && <p role="alert" className="a2-error">{error}</p>}
          <CallButtons voice={voice} />
          <p className="a2-footnote">{info.agentName} is an AI interviewer. {info.employer} records this call.</p>
        </> : <div className="a2-before">
          <div className="a2-identity">{face()}<h1>{info.agentName}</h1><p>AI interviewer for {info.employer}</p></div>
          <div className="a2-caption"><p>{info.state === "live" ? "This interview is in progress on another device." : `Hi${info.candidateFirst ? ` ${info.candidateFirst}` : ""}. ${info.agentName} is ${info.employer}'s AI interviewer. This is a short screening: a few minutes and two questions about the ${info.jobTitle} job. If it goes well, you can do your new-hire paperwork on this same call. Find a quiet spot, and allow the microphone when your browser asks.`}</p></div>
          {error && <p role="alert" className="a2-error">{error}</p>}
          {!info.voiceReady && <p className="a2-not-ready">This interview is not ready yet. Please ask the recruiter to check back with you.</p>}
          <button type="button" className="a2-start" data-testid="candidate-start" disabled={!info.voiceReady || voice.connecting || info.state !== "ready"} onClick={() => { setNotice(null); void voice.start(); }}>{voice.connecting && <Loader2 size={20} className="animate-spin" />}{voice.connecting ? "Connecting…" : "Start the interview"}</button>
        </div>}
        {(closed || (finished && !info.formApp)) && error && <p role="alert" className="a2-error">{error}</p>}
      </div>
    </div>
  </main>;
}
