import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Mic, Pencil, Loader2 } from "lucide-react";
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
  const recognition = useRef<SpeechRecognizer | null>(null);
  const acting = useRef(false);
  const problem = useProblem();
  const navigate = useNavigate();
  useEffect(() => () => { recognition.current?.abort(); }, []);
  const write = async (event: FormEvent) => {
    event.preventDefault();
    if (acting.current) return;
    acting.current = true; setWriting(true); problem.clear(); setEditing(null);
    recognition.current?.stop();
    try { await request("/api/me/questions", { method: "POST", body: JSON.stringify({ description }) }); }
    catch (reason) { problem.report(reason); }
    finally { acting.current = false; setWriting(false); }
  };
  const save = async () => {
    if (acting.current || !builder) return;
    if (wording.trim().length < 10 || wording.trim().length > 240) { setEditError("Use 10 to 240 characters for the question."); return; }
    acting.current = true; setSaving(true); setEditError(null);
    try { await update({ questions: builder.questions.map(q => ({ id: q.id, question: q.id === editing ? wording.trim() : q.question })) }); setEditing(null); }
    catch (reason) { setEditError(reason instanceof ApiError ? reason.errors.find(error => error.field === "questions")?.message ?? reason.message : reason instanceof Error ? reason.message : "The question could not be saved."); }
    finally { acting.current = false; setSaving(false); }
  };
  const dictate = () => {
    if (listening) { recognition.current?.stop(); return; }
    const Constructor = speechConstructor();
    if (!Constructor) return;
    const speech = new Constructor();
    speech.lang = navigator.language; speech.continuous = true; speech.interimResults = true;
    const before = description.trim();
    speech.onresult = event => {
      const words = Array.from(event.results).map(result => result[0].transcript).join(" ");
      setDescription([before, words].filter(Boolean).join(" ").slice(0, 1500));
    };
    speech.onerror = event => { setSpeechError(event.error === "not-allowed" ? "Microphone access was denied. Allow it in your browser, or type your description." : "Speech recognition stopped. Try again, or type your description."); setListening(false); };
    speech.onend = () => setListening(false);
    recognition.current = speech; setSpeechError(null);
    try { speech.start(); setListening(true); } catch { setSpeechError("Speech recognition could not start. Try again, or type your description."); }
  };
  const count = builder?.questions.length ?? 0;
  const panel = <aside className="agent-panel" aria-label="The questions your agent will ask"><div className="panel-eyebrow"><span>Your agent will ask</span><span aria-live="polite">{count} of 2 questions</span></div><div className="question-panel-body"><ol className="question-list" aria-live="polite">{count ? builder?.questions.map((question, i) => <li className="question-card" key={question.id}><span className="question-number">{i + 1}</span><div className="question-copy">{editing === question.id ? <form className="question-edit" onSubmit={event => { event.preventDefault(); void save(); }}><label htmlFor={`edit-${question.id}`}>Question {i + 1}</label><textarea id={`edit-${question.id}`} autoFocus rows={4} minLength={10} maxLength={240} required value={wording} disabled={saving} onChange={event => setWording(event.target.value)} aria-invalid={!!editError} aria-describedby="question-edit-error" /><FieldError id="question-edit-error">{editError}</FieldError><div className="button-row"><button className="secondary-button" disabled={saving} aria-busy={saving}>{saving ? "Saving…" : "Save"}</button><button className="text-button" type="button" disabled={saving} onClick={() => setEditing(null)}>Cancel</button></div></form> : <p>{question.question}</p>}<span>Scored as <strong>{question.topic}</strong></span></div>{!editing && <button className="edit-question" type="button" aria-label={`Edit question ${i + 1}`} disabled={writing} onClick={() => { setEditing(question.id); setWording(question.question); setEditError(null); }}><Pencil size={16} /></button>}</li>) : [1, 2].map(number => <li key={number} className={`question-card placeholder ${writing ? "writing" : ""}`}><span className="question-number">{number}</span><div className="question-copy"><p>{writing ? "Writing your question…" : "Your question will appear here"}</p><span>{writing ? "Finding what matters most in your description" : "Describe your screening to get started"}</span></div></li>)}</ol><ul className="part-list" style={{ maxWidth: "none", flex: "none" }}><PartCard title="Added by Onboarded to every agent" compliance state="done">Where they would work, their legal name, and a start date checked against form deadlines. The forms after the offer depend on these.</PartCard></ul></div></aside>;
  return <BuildLayout step={3} panel={panel} footer={<StepFooter back="/" disabled={count !== 2 || writing || saving || !!editing} onNext={() => navigate("/name")} />}><PageHeading title="What should your agent screen for?">Your agent asks two screening questions, then moves to the offer and the forms. Tell it what matters most, the way you would brief a recruiter.</PageHeading><form className="builder-form" onSubmit={event => void write(event)}><div className="field"><div className="label-row"><label htmlFor="bca-brief">Your screening, in your own words</label><span>Becomes 2 questions</span></div><textarea id="bca-brief" rows={6} required minLength={20} maxLength={1500} value={description} onChange={event => setDescription(event.target.value)} placeholder="Tell us about the role and the two things you care about most." aria-invalid={!!problem.field("description")} aria-describedby="brief-hint brief-error" disabled={writing} /><FieldError id="brief-error">{problem.field("description")}</FieldError></div><div className="button-row"><button className={`secondary-button ${count !== 2 ? "is-primary" : ""}`} disabled={writing || saving || description.trim().length < 20} aria-busy={writing}>{writing && <Loader2 size={16} className="animate-spin" />}{writing ? "Writing your questions…" : "Write my two questions"}</button>{speechConstructor() && <button type="button" className="secondary-button" onClick={dictate} disabled={writing || saving} aria-pressed={listening}><Mic size={16} />{listening ? "Stop listening" : "Say it instead"}</button>}</div><span role="status" className="field-hint">{listening ? "Listening… Your words will appear above." : ""}</span><p id="brief-hint" className="field-hint">Two is the limit, so the call reaches the offer and the forms quickly. Describe it again, or edit a question on the right, as often as you like.</p><FieldError>{problem.field("questions")}</FieldError><FieldError>{problem.message ?? speechError}</FieldError></form></BuildLayout>;
}
