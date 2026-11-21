import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useBuilder } from "@/lib/builder";
import { Check, ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { OnboardedIcon } from "../call/brand";

export function SiteMark() {
  return <div className="site-mark"><OnboardedIcon size={22} /><span>compliance.build</span></div>;
}
export function Stepper({ step }: { step: number }) {
  return <ol className="stepper" aria-label="Steps to build your agent">{["Company", "Email", "Questions", "Name"].map((label, i) => <li key={label} className={i + 1 <= step ? "reached" : ""} aria-current={i + 1 === step ? "step" : undefined}><span className="step-number">{i + 1 < step ? <Check size={12} strokeWidth={3.2} /> : i + 1}</span><span>{label}</span></li>)}</ol>;
}
/** Forgets this browser's agent and returns to the first screen. The first press arms it, the second does it. */
export function StartOver({ label, className, disabled }: { label: string; className?: string; disabled?: boolean }) {
  const { forget } = useBuilder();
  const navigate = useNavigate();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);
  return <button type="button" className={className} disabled={disabled} aria-live="polite" onClick={() => { if (!armed) { setArmed(true); return; } forget(); navigate("/"); }}>{armed ? "Press again to start over" : label}</button>;
}
/**
 * The Back and Continue bar. A step's general error is shown inside it, above the buttons: on a
 * phone the bar is fixed to the bottom of the screen, and an error further down the page than the
 * screen shows was never seen (a visitor pressed Continue and nothing appeared to happen).
 */
export function StepFooter({ back, start, label = "Continue", busy, disabled, onNext, form, error }: { back?: string; start?: ReactNode; label?: string; busy?: boolean; disabled?: boolean; onNext?: () => void; form?: string; error?: ReactNode }) {
  return <footer className="step-footer">{error ? <p role="alert" className="field-error step-error">{error}</p> : null}<div className="step-actions">{back ? <Link className="back-button" to={back}><ArrowLeft size={16} />Back</Link> : start ?? <span />}<button className="primary-button" type={form ? "submit" : "button"} form={form} onClick={onNext} disabled={disabled || busy} aria-busy={busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : null}{busy ? "Please wait…" : label}<ArrowRight size={16} /></button></div></footer>;
}
export function BuildLayout({ step, children, panel, footer }: { step: number; children: ReactNode; panel: ReactNode; footer: ReactNode }) {
  const { builder } = useBuilder();
  return <div className="build-layout"><main className="build-main"><div className="build-column"><header className="build-header"><div className="build-top"><SiteMark />{builder && <StartOver label="New agent" className="back-button new-agent" />}</div><Stepper step={step} /></header><div className="build-content">{children}</div>{footer}</div></main>{panel}</div>;
}
export function PageHeading({ title, children }: { title: string; children: ReactNode }) {
  return <div className="page-heading"><h1>{title}</h1><p>{children}</p></div>;
}
export function FieldError({ id, children }: { id?: string; children?: ReactNode }) {
  return children ? <p id={id} role="alert" className="field-error">{children}</p> : null;
}
