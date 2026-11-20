import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { localToday, type CandidateInterview, type InterviewSession } from "@shared/interview";
import { ApiError, apiFetch, SESSION_KEY } from "@/lib/api";
import { OnboardedIcon } from "@/components/call/brand";
import { AgentCall } from "@/components/call/AgentCall";
import { WatchView } from "@/components/call/WatchView";
import { StartOver } from "@/components/build/BuildLayout";

interface CallData { session: InterviewSession; candidate: CandidateInterview; token: string }
async function withCandidate(session: InterviewSession): Promise<CallData> {
  if (!session.linkToken) throw new Error("This call has no candidate link. Please create a new call.");
  const token = session.linkToken;
  const candidate = await apiFetch<CandidateInterview>(`/api/public/interviews/${encodeURIComponent(token)}`);
  localStorage.setItem(SESSION_KEY, session.id);
  return { session, candidate, token };
}
const createSession = () => apiFetch<InterviewSession>("/api/sessions", { method: "POST", body: JSON.stringify({ today: localToday() }) });
async function latestCall() {
  let session: InterviewSession;
  try { session = await apiFetch<InterviewSession>("/api/sessions/latest"); }
  catch (reason) { if (!(reason instanceof ApiError) || reason.status !== 404) throw reason; session = await createSession(); }
  return withCandidate(session);
}
export function Call() {
  const [data, setData] = useState<CallData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [onCall, setOnCall] = useState(false);
  const boot = useRef<Promise<CallData> | null>(null);
  const acting = useRef(false);
  useEffect(() => {
    let cancelled = false;
    boot.current ??= latestCall();
    void boot.current.then(next => { if (!cancelled) { setData(next); setOnCall(next.candidate.state === "live"); } }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "The call could not be opened."); });
    return () => { cancelled = true; };
  }, []);
  const newCall = async (fresh: boolean) => {
    if (acting.current || onCall) return;
    acting.current = true; setPending(true); setError(null);
    try { const next = fresh ? await withCandidate(await createSession()) : await latestCall(); setData(next); setOnCall(next.candidate.state === "live"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The call could not be opened."); }
    finally { acting.current = false; setPending(false); }
  };
  return <div className="call-layout"><div className="call-left"><header className="call-nav"><Link to="/" aria-label="Build a compliant agent home"><OnboardedIcon size={20} /></Link><span>buildacompliantagent.com</span><Link to="/">Edit the agent</Link><StartOver label="New agent" disabled={pending || onCall} /><button type="button" disabled={pending || onCall} onClick={() => void newCall(true)} aria-busy={pending}>{pending ? "Creating…" : "New call"}</button></header><div className="candidate-label"><strong>The candidate's phone</strong><p>Your agent, in your brand. You are the candidate. This is a demo: use made-up details on the forms.</p></div>{error && <div className="call-error"><p role="alert">{error}</p><button className="secondary-button" disabled={pending} onClick={() => void newCall(false)}>{pending ? "Opening…" : "Try again"}</button></div>}{data ? <AgentCall key={data.session.id} token={data.token} initial={data.candidate} onBusyChange={setOnCall} /> : !error && <div className="status-page"><Loader2 className="animate-spin" /><p role="status">Preparing your test call…</p></div>}</div>{data && <WatchView key={data.session.id} initial={data.session} />}</div>;
}

// A session's candidate link can also be opened on a phone, using the link token alone.
export function CandidateCall() {
  const { token = "" } = useParams();
  const [info, setInfo] = useState<CandidateInterview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/public/interviews/${encodeURIComponent(token)}`).then(async response => {
      if (!response.ok) { const body = await response.json().catch(() => null) as { error?: string } | null; throw new Error(body?.error ?? "This interview link does not work."); }
      return response.json() as Promise<CandidateInterview>;
    }).then(next => { if (!cancelled) setInfo(next); }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "This interview link does not work."); });
    return () => { cancelled = true; };
  }, [token]);
  return info ? <AgentCall key={token} token={token} initial={info} /> : <main className="status-page">{error ? <><h1>This link does not work</h1><p role="alert">{error}</p><Link to="/" className="primary-button">Return to the start</Link></> : <p role="status">Opening your interview…</p>}</main>;
}
