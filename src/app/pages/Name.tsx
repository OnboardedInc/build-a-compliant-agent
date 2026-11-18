import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBuilder } from "@/lib/builder";
import { useProblem } from "@/lib/useProblem";
import { AgentFace, FACE_LABELS } from "@/components/AgentFace";
import { AgentPanel } from "@/components/build/AgentPanel";
import { BuildLayout, FieldError, PageHeading, StepFooter } from "@/components/build/BuildLayout";

const nameProblem = (name: string) => !name.trim() ? "Give your agent a name." : !/^[a-zA-Z0-9 '-]{1,8}$/.test(name.trim()) ? "Use 1 to 8 letters, digits, spaces, hyphens or apostrophes." : null;
export function Name() {
  const { builder, update, request } = useBuilder();
  const [name, setName] = useState(builder?.agentName ?? "");
  const [face, setFace] = useState(builder?.agentFace ?? 1);
  const [saveState, setSaveState] = useState("All changes saved");
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const latest = useRef({ name, face }); latest.current = { name, face };
  const saved = useRef({ name: builder?.agentName ?? "", face: builder?.agentFace ?? 0 });
  const generation = useRef(0);
  const acting = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const problem = useProblem();
  const navigate = useNavigate();
  useEffect(() => {
    if (nameProblem(name) || (saved.current.name === name.trim() && saved.current.face === face)) return;
    const id = ++generation.current;
    setSaveState("Unsaved changes");
    timer.current = setTimeout(() => {
      setSaveState("Saving…");
      void update({ agentName: name.trim(), agentFace: face }).then(() => {
        saved.current = { name: name.trim(), face };
        if (id === generation.current) { setSaveState("All changes saved"); problem.clear(); }
      }).catch(reason => { if (id === generation.current) { setSaveState("Could not save changes"); problem.report(reason); } });
    }, 600);
    return () => { if (timer.current) clearTimeout(timer.current); generation.current += 1; };
  }, [name, face, update]);
  const build = async () => {
    if (acting.current) return;
    const invalid = nameProblem(latest.current.name);
    setLocalError(invalid);
    if (invalid) { document.getElementById("bca-name")?.focus(); return; }
    acting.current = true; setPending(true); generation.current += 1;
    if (timer.current) clearTimeout(timer.current);
    problem.clear();
    try {
      await update({ agentName: latest.current.name.trim(), agentFace: latest.current.face });
      await request("/api/me/build", { method: "POST" });
      navigate("/built");
    } catch (reason) { problem.report(reason); }
    finally { acting.current = false; setPending(false); }
  };
  const error = localError ?? problem.field("agentName");
  return <BuildLayout step={4} panel={<AgentPanel step={4} builder={builder} name={name} face={face} />} footer={<StepFooter back="/questions" label="Build my agent" busy={pending} onNext={() => void build()} />}><PageHeading title="Give your agent a name and a face">Candidates hear the name at the start of the call and see the face while they talk.</PageHeading><form className="builder-form" onSubmit={event => { event.preventDefault(); void build(); }}><div className="field" style={{ maxWidth: 240 }}><div className="label-row"><label htmlFor="bca-name">Agent name</label><span>{name.length} / 8</span></div><input id="bca-name" autoComplete="off" required maxLength={8} value={name} disabled={pending} onChange={event => { setName(event.target.value); setLocalError(null); }} aria-invalid={!!error} aria-describedby="name-hint name-error" /><span id="name-hint" className="field-hint">Up to 8 characters, so it fits on the call screen.</span><FieldError id="name-error">{error}</FieldError></div><fieldset className="face-fieldset" disabled={pending}><legend>Face</legend><div className="face-grid">{FACE_LABELS.map((label, i) => <button key={label} type="button" aria-label={label} aria-pressed={face === i + 1} onClick={() => setFace(i + 1)}><AgentFace face={i + 1} size={40} head={face === i + 1 ? "#14193D" : "#424B6B"} /></button>)}</div><FieldError>{problem.field("agentFace")}</FieldError></fieldset><p role="status" className="field-hint">{saveState}</p><FieldError>{problem.message}</FieldError></form></BuildLayout>;
}
