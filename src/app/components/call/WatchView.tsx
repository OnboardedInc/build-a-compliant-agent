import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { formatClock, type AgentForm, type ApiCall, type FormSource, type InterviewSession, type InterviewStatus } from "@shared/interview";
import { useSession } from "./useSession";
import { OnboardedWordmark } from "./brand";
import "./agent2.css";

const statusWords: Record<InterviewStatus, string> = {
  idle: "Waiting for the candidate", live: "Live call", ended: "Call ended", review: "Call ended",
  approving: "Approving", approved: "Approved", rejected: "Rejected",
};
const percent = (value: number) => Math.min(100, Math.max(0, value));
function SourceTag({ source }: { source: FormSource }) {
  return <span className={`a2-source ${source}`}>{source === "library" ? "Library" : source === "custom" ? "Custom" : "Integration"}</span>;
}
function FormStatus({ form }: { form: AgentForm }) {
  return <div className="a2-form-status"><span className={`a2-status ${form.state}`}>{form.status}</span>{form.state === "open" && <div role="progressbar" aria-label={`${form.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(form.percent)} className="a2-task-progress"><span style={{ width: `${percent(form.percent)}%` }} /></div>}</div>;
}
function ApiCard({ call, fresh, agentName }: { call: ApiCall; fresh: boolean; agentName: string }) {
  const at = new Date(call.at);
  const time = Number.isNaN(at.getTime()) ? "—" : `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}:${String(at.getSeconds()).padStart(2, "0")}`;
  const tag = call.service === "vapi" ? call.direction === "in" ? agentName : "Vapi" : call.method;
  return <li className={`a2-api-card ${fresh ? "a2-api-new" : ""}`}><div className="a2-api-title"><span className={`a2-method ${call.service === "onboarded" ? call.method.toLowerCase() : "vapi"}`}>{tag}</span><code>{call.path}</code><span className="a2-api-time"><time dateTime={call.at}>{time}</time> · {call.status}</span></div>{call.detail && <p className="a2-api-detail">{call.detail}</p>}{call.returned.slice(0, 3).map((line, i) => <code className="a2-api-return" key={i}>{line}</code>)}{call.result && <span className="a2-api-result">{call.result}</span>}</li>;
}
export function WatchView({ initial }: { initial: InterviewSession }) {
  const { session, refresh, report, act, pending, error } = useSession(initial);
  const journey = session.journey;
  const [callSeconds, setCallSeconds] = useState(session.callSeconds);
  const initialCalls = useRef(new Set(initial.api.map(call => call.id)));
  const transcript = useRef<HTMLDivElement>(null);
  const settled = journey.stage === "ready" && !!session.hire?.ready;
  // useSession follows approved hires until ready; the watch follows the screening too.
  const followingHire = session.status === "approved" && !session.hire?.ready;
  useEffect(() => {
    setCallSeconds(session.callSeconds);
    if (session.status !== "live") return;
    const started = Date.now();
    const timer = setInterval(() => setCallSeconds(session.callSeconds + Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [session.status, session.callSeconds]);
  useEffect(() => {
    if (settled || followingHire) return;
    let stopped = false;
    let reading = false;
    const timer = setInterval(() => {
      if (reading) return;
      reading = true;
      void refresh().catch(reason => { if (!stopped) report(reason); }).finally(() => { reading = false; });
    }, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [settled, followingHire, refresh, report]);
  useEffect(() => {
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [session.transcript]);
  const forms = journey.forms;
  const complete = forms.filter(form => form.state === "done").length;
  const sourced = forms.some(form => form.source !== null);
  const offer = journey.offer;
  const scored = session.criteria.filter(criterion => criterion.score !== null).length;
  // "So far" is the mean of the topics already scored: a topic not yet asked is not a zero.
  const soFar = scored > 0 ? Math.round(session.criteria.reduce((sum, criterion) => sum + (criterion.score ?? 0), 0) / scored) : 0;
  const offerWords = offer === "accepted" ? "Offer accepted" : offer === "offered" ? "Offer made, waiting for the answer" : offer === "review" ? "No offer on the call: the team decides" : "No offer yet";
  const offerDetail = journey.steps.find(step => step.id === "offer")?.detail;
  const canApprove = offer === "review" && session.status !== "approved" && session.status !== "live";
  // The feed shows what Onboarded does. The voice provider's calls are how the agent is built, not what this view is for.
  const shownCalls = session.api.filter(call => call.service !== "vapi");
  return <section className="a2-watch" aria-label="Behind the call" data-testid="watch-view" data-stage={journey.stage}><div className="a2-watch-left">
    <header className="a2-behind-heading"><div><h1>Behind the call</h1><p>What a recruiter watches, and what Onboarded does at each step.</p></div><span className="a2-powered">Powered by <OnboardedWordmark height={12} /></span><span className={`a2-watch-live ${session.status === "live" ? "is-live" : ""}`} role="status">{statusWords[session.status]}{session.status === "live" && <> · <time>{formatClock(callSeconds)}</time></>}</span></header>
    {(error || session.error) && <p role="alert" className="a2-watch-error">{error || session.error}</p>}
    <section className="a2-watch-journey a2-panel" aria-label="Journey" aria-live="polite"><ol>{journey.steps.map(step => <li key={step.id} aria-current={step.state === "now" ? "step" : undefined}><span className={`a2-watch-step ${step.state}`} /><b>{step.label}{step.state === "now" && <span className="a2-now">Now</span>}</b><p>{step.detail}</p></li>)}</ol></section>
    <section className={`a2-panel a2-offer ${offer === "accepted" ? "accepted" : ""}`} aria-label="Interview score and offer" aria-live="polite" data-testid="watch-offer" data-offer={offer}>
      <header className="a2-step-head"><span className="a2-step-tag">Steps 1 and 2 · Screen and offer</span>{offer === "accepted" ? <p className="a2-score-summary">Fit score <strong>{session.score}</strong><span> · {session.criteria.map(criterion => `${criterion.label} ${criterion.score ?? "—"}`).join(" · ")}</span></p> : <h2>Your two questions decide the offer</h2>}<span className={`a2-offer-state ${offer}`}>{offerWords}</span></header>
      {offer !== "accepted" && <div className="a2-offer-body"><div className="a2-fit"><b>{scored > 0 ? soFar : "—"}</b><div><span>{scored < session.criteria.length ? "Fit score so far" : "Fit score"}</span><small>Offer on the call at {session.job.threshold} or above</small></div></div><div className="a2-offer-side"><ul>{session.criteria.map(criterion => <li key={criterion.id}><span>{criterion.label}</span><b>{criterion.score ?? "—"}</b></li>)}</ul>{offerDetail && <p>{offerDetail}</p>}{canApprove && <div className="a2-approve"><p>Score is under the threshold: the offer is yours to make.</p><button type="button" onClick={() => void act("approve")} disabled={pending || session.status === "approving"} aria-busy={pending}>{pending || session.status === "approving" ? "Approving…" : "Approve offer"}</button></div>}</div></div>}
    </section>
    <section className="a2-panel a2-requirements" aria-label="Placement requirements, by Onboarded"><header className="a2-panel-brand"><span className="a2-step-tag">Step 3 · Forms</span><OnboardedWordmark height={16} /><span className="a2-brand-divider" /><h2>Placement requirements</h2><span className="a2-completion" aria-live="polite">{complete} of {forms.length} complete<span className="a2-total-progress" role="progressbar" aria-label="Placement requirements complete" aria-valuemin={0} aria-valuemax={forms.length || 1} aria-valuenow={complete}><span style={{ width: `${forms.length ? complete / forms.length * 100 : 0}%` }} /></span></span></header>
      <div className="a2-requirements-body"><p className="a2-policy-note">{session.hire ? "Created in Onboarded when the offer was accepted, from the account's policies for this job and work site. Status is read from each task." : "What Onboarded will create when the offer is accepted, from the account's policies for this job and work site. The forms open on the candidate's screen when they accept."}</p>{sourced && <div className="a2-source-legend"><span><SourceTag source="library" />Onboarded's compliance library</span><span><SourceTag source="custom" />{session.company}'s own form</span><span><SourceTag source="integration" />Run with a connected service</span></div>}{forms.length === 0 && <p className="a2-empty">Onboarded lists the forms here once the candidate picks a work site.</p>}
        <div className="a2-table-scroll" tabIndex={0} role="region" aria-label="Placement requirements table"><table data-testid="watch-forms"><thead><tr><th scope="col">Form</th>{sourced && <th scope="col">Source</th>}<th scope="col">Whose turn</th><th scope="col">Status</th><th scope="col">Due</th></tr></thead><tbody>{forms.map(form => <tr key={form.taskId} className={form.now || form.state === "open" ? "open" : ""} data-now={form.now ? "true" : undefined}><td><b>{form.name}</b>{form.now && <span className="a2-on-screen">On {session.candidate.first || "the candidate"}'s screen</span>}{form.note && <p>{form.note}</p>}</td>{sourced && <td>{form.source ? <SourceTag source={form.source} /> : "—"}</td>}<td>{form.whose}</td><td><FormStatus form={form} /></td><td>{form.due ?? "—"}</td></tr>)}</tbody></table></div>
        <div className="a2-ready-note"><span className={`a2-ready-tick ${session.hire?.ready ? "done" : ""}`} aria-hidden="true">{session.hire?.ready && <Check size={12} />}</span><div><strong>Step 4 · Ready for work</strong><p>{session.journey.employerPart ? `Ready for work when every form is done, ${session.company}'s part included.` : "Ready for work when every form is done."}</p>{session.hire?.employerUrl && <a className="a2-employer-link" href={session.hire.employerUrl} target="_blank" rel="noopener noreferrer">Open {session.company}'s part</a>}</div></div>
      </div></section>
    <section className="a2-panel a2-transcript-panel" aria-label="Transcript"><div className="a2-transcript-title"><h2>Transcript</h2><span>{session.agentName} and {session.candidate.first || "the candidate"} · latest lines</span></div><div className="a2-transcript" ref={transcript} data-testid="watch-transcript" tabIndex={0}><ol>{session.transcript.map(line => <li key={line.id}><div><b className={line.who === "ai" ? "agent" : "candidate"}>{line.who === "ai" ? session.agentName : session.candidate.first || "Candidate"}</b><time>{formatClock(line.at)}</time></div><p>{line.text}</p></li>)}</ol>{session.transcript.length === 0 && <p className="a2-empty">The conversation will appear here when the call begins.</p>}</div></section>
  </div><section className="a2-api" aria-label="Onboarded API calls"><header className="a2-panel-brand"><OnboardedWordmark height={14} /><h2>API</h2><span className="a2-api-live"><i />Live</span></header><p className="a2-api-count">{session.api.filter(call => call.service === "onboarded").length} calls to Onboarded's public API · newest first</p><ol data-testid="watch-api">{[...shownCalls].reverse().map(call => <ApiCard key={call.id} call={call} agentName={session.agentName} fresh={!initialCalls.current.has(call.id)} />)}</ol>{shownCalls.length === 0 && <p className="a2-empty">API calls will appear as the interview moves forward.</p>}</section></section>;
}
