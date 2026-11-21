import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Mic, Pencil, Loader2 } from "lucide-react";
import { useBuilder } from "@/lib/builder";
import { useProblem } from "@/lib/useProblem";
import { ApiError } from "@/lib/api";
import { BuildLayout, FieldError, PageHeading, StepFooter } from "@/components/build/BuildLayout";
import { PartCard } from "@/components/build/PartCard";

interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface SpeechRecognizer {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type SpeechConstructor = new () => SpeechRecognizer;
function speechConstructor(): SpeechConstructor | undefined {
  const browser = window as unknown as { SpeechRecognition?: SpeechConstructor; webkitSpeechRecognition?: SpeechConstructor };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}
export function Questions() {
  const { builder, request, update } = useBuilder();
  const [description, setDescription] = useState(builder?.description ?? "");
  const [writing, setWriting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [wording, setWording] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  /** Words heard so far. The words themselves are not shown while the visitor is speaking. */
  const [heard, setHeard] = useState(0);
  /** Speech arrived in the last second: the bars move, so the visitor can see they are heard. */
  const [hearing, setHearing] = useState(false);
  const recognition = useRef<SpeechRecognizer | null>(null);
  const spoken = useRef("");
  const dropped = useRef(false);
  const stopReason = useRef<string | null>(null);
  const quiet = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const acting = useRef(false);
  const problem = useProblem();
  const navigate = useNavigate();
  useEffect(() => () => { dropped.current = true; clearTimeout(quiet.current); recognition.current?.abort(); }, []);
  const writeFrom = async (text: string) => {
    if (acting.current) return;
    acting.current = true; setWriting(true); problem.clear(); setEditing(null);
    try { await request("/api/me/questions", { method: "POST", body: JSON.stringify({ description: text }) }); }
    catch (reason) { problem.report(reason); }
    finally { acting.current = false; setWriting(false); }
  };
  const write = (event: FormEvent) => {
    event.preventDefault();
    // Submitting while speaking is the same as pressing Done.
    if (listening) { recognition.current?.stop(); return; }
    void writeFrom(description);
  };
  const save = async () => {
    if (acting.current || !builder) return;
    if (wording.trim().length < 10 || wording.trim().length > 240) { setEditError("Use 10 to 240 characters for the question."); return; }
    acting.current = true; setSaving(true); setEditError(null);
    try { await update({ questions: builder.questions.map(q => ({ id: q.id, question: q.id === editing ? wording.trim() : q.question })) }); setEditing(null); }
    catch (reason) { setEditError(reason instanceof ApiError ? reason.errors.find(error => error.field === "questions")?.message ?? reason.message : reason instanceof Error ? reason.message : "The question could not be saved."); }
    finally { acting.current = false; setSaving(false); }
  };
  // Speaking is one step: press the button, say it, press Done (or stop talking), and the two
  // questions are written from what was said. The words are not shown while the visitor
  // speaks; they are in the box afterwards, to read and change.
  const dictate = () => {
    const Constructor = speechConstructor();
    if (!Constructor || listening) return;
    const speech = new Constructor();
    speech.lang = navigator.language; speech.continuous = true; speech.interimResults = true;
    spoken.current = ""; dropped.current = false; stopReason.current = null;
    setHeard(0); setHearing(false); setSpeechError(null); problem.clear();
    speech.onresult = event => {
      spoken.current = Array.from(event.results).map(result => result[0].transcript.trim()).filter(Boolean).join(" ").slice(0, 1500);
      setHeard(spoken.current ? spoken.current.split(/\s+/).length : 0);
      setHearing(true);
      clearTimeout(quiet.current);
      quiet.current = setTimeout(() => setHearing(false), 900);
    };
    speech.onerror = event => {
      if (event.error === "aborted" || event.error === "no-speech") return;
      stopReason.current = event.error === "not-allowed" || event.error === "service-not-allowed" ? "Microphone access was denied. Allow it in your browser, or type your description." : "Speech recognition stopped. Try again, or type your description.";
    };
    speech.onend = () => {
      clearTimeout(quiet.current);
      recognition.current = null;
      if (dropped.current) return;
      setListening(false); setHearing(false);
      const text = spoken.current.trim();
      if (text.length < 20) { setSpeechError(stopReason.current ?? "We did not hear enough to write questions from. Try again, or type your description."); return; }
      setDescription(text);
      void writeFrom(text);
    };
    recognition.current = speech;
    try { speech.start(); setListening(true); } catch { recognition.current = null; setSpeechError("Speech recognition could not start. Try again, or type your description."); }
  };
  const cancelSpeaking = () => { dropped.current = true; clearTimeout(quiet.current); recognition.current?.abort(); recognition.current = null; setListening(false); setHearing(false); };
  const count = builder?.questions.length ?? 0;
  const panel = <aside className="agent-panel" aria-label="The questions your agent will ask"><div className="panel-eyebrow"><span>Your agent will ask</span><span aria-live="polite">{count} of 2 questions</span></div><div className="question-panel-body"><ol className="question-list" aria-live="polite">{count ? builder?.questions.map((question, i) => <li className="question-card" key={question.id}><span className="question-number">{i + 1}</span><div className="question-copy">{editing === question.id ? <form className="question-edit" onSubmit={event => { event.preventDefault(); void save(); }}><label htmlFor={`edit-${question.id}`}>Question {i + 1}</label><textarea id={`edit-${question.id}`} autoFocus rows={4} minLength={10} maxLength={240} required value={wording} disabled={saving} onChange={event => setWording(event.target.value)} aria-invalid={!!editError} aria-describedby="question-edit-error" /><FieldError id="question-edit-error">{editError}</FieldError><div className="button-row"><button className="secondary-button" disabled={saving} aria-busy={saving}>{saving ? "Saving…" : "Save"}</button><button className="text-button" type="button" disabled={saving} onClick={() => setEditing(null)}>Cancel</button></div></form> : <p>{question.question}</p>}<span>Scored as <strong>{question.topic}</strong></span></div>{!editing && <button className="edit-question" type="button" aria-label={`Edit question ${i + 1}`} disabled={writing} onClick={() => { setEditing(question.id); setWording(question.question); setEditError(null); }}><Pencil size={16} /></button>}</li>) : [1, 2].map(number => <li key={number} className={`question-card placeholder ${writing ? "writing" : ""}`}><span className="question-number">{number}</span><div className="question-copy"><p>{writing ? "Writing your question…" : "Your question will appear here"}</p><span>{writing ? "Finding what matters most in your description" : "Describe your screening to get started"}</span></div></li>)}</ol><ul className="part-list" style={{ maxWidth: "none", flex: "none" }}><PartCard title="Added by Onboarded to every agent" compliance state="done">Where they would work, their legal name, and a start date checked against form deadlines. The forms after the offer depend on these.</PartCard></ul></div></aside>;
  return <BuildLayout step={3} panel={panel} footer={<StepFooter back="/" disabled={count !== 2 || writing || saving || !!editing} onNext={() => navigate("/name")} error={problem.message ?? speechError} />}><PageHeading title="What should your agent screen for?">Your agent asks two screening questions, then moves to the offer and the forms. Tell it what matters most, the way you would brief a recruiter.</PageHeading><form className="builder-form" onSubmit={event => void write(event)}><div className="field"><div className="label-row"><label htmlFor="bca-brief">Your screening, in your own words</label><span>Becomes 2 questions</span></div>{listening ? <div className="listening-box" data-testid="listening" data-hearing={hearing}><div className="listening-bars" aria-hidden="true"><i /><i /><i /><i /><i /></div><strong role="status">Listening…</strong><span>{heard ? `${heard} ${heard === 1 ? "word" : "words"} so far. Press Done when you have said it all.` : "Tell us about the role and the two things you care about most."}</span></div> : <textarea id="bca-brief" rows={6} required minLength={20} maxLength={1500} value={description} onChange={event => setDescription(event.target.value)} placeholder="Tell us about the role and the two things you care about most." aria-invalid={!!problem.field("description")} aria-describedby="brief-hint brief-error" disabled={writing} />}<FieldError id="brief-error">{problem.field("description")}</FieldError></div><div className="button-row">{listening ? <><button type="button" className="secondary-button is-primary" onClick={() => recognition.current?.stop()}><Check size={16} />Done, write my questions</button><button type="button" className="secondary-button" onClick={cancelSpeaking}>Cancel</button></> : <><button className={`secondary-button ${count !== 2 ? "is-primary" : ""}`} disabled={writing || saving || description.trim().length < 20} aria-busy={writing}>{writing && <Loader2 size={16} className="animate-spin" />}{writing ? "Writing your questions…" : "Write my two questions"}</button>{speechConstructor() && <button type="button" className="secondary-button" onClick={dictate} disabled={writing || saving}><Mic size={16} />Say it instead</button>}</>}</div><p id="brief-hint" className="field-hint">Two is the limit, so the call reaches the offer and the forms quickly. Describe it again (up to ten times a day), or edit a question on the right.</p><FieldError>{problem.field("questions")}</FieldError></form></BuildLayout>;
}
