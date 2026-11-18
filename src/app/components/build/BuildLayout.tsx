import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { OnboardedIcon } from "../call/brand";

export function SiteMark() {
  return <div className="site-mark"><OnboardedIcon size={22} /><span>buildacompliantagent.com</span></div>;
}
export function Stepper({ step }: { step: number }) {
  return <ol className="stepper" aria-label="Steps to build your agent">{["Company", "Email", "Questions", "Name"].map((label, i) => <li key={label} className={i + 1 <= step ? "reached" : ""} aria-current={i + 1 === step ? "step" : undefined}><span className="step-number">{i + 1 < step ? <Check size={12} strokeWidth={3.2} /> : i + 1}</span><span>{label}</span></li>)}</ol>;
}
export function StepFooter({ back, label = "Continue", busy, disabled, onNext, form }: { back?: string; label?: string; busy?: boolean; disabled?: boolean; onNext?: () => void; form?: string }) {
  return <footer className="step-footer">{back ? <Link className="back-button" to={back}><ArrowLeft size={16} />Back</Link> : <span />}<button className="primary-button" type={form ? "submit" : "button"} form={form} onClick={onNext} disabled={disabled || busy} aria-busy={busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : null}{busy ? "Please wait…" : label}<ArrowRight size={16} /></button></footer>;
}
export function BuildLayout({ step, children, panel, footer }: { step: number; children: ReactNode; panel: ReactNode; footer: ReactNode }) {
  return <div className="build-layout"><main className="build-main"><header className="build-header"><SiteMark /><Stepper step={step} /></header><div className="build-content">{children}</div>{footer}</main>{panel}</div>;
}
export function PageHeading({ title, children }: { title: string; children: ReactNode }) {
  return <div className="page-heading"><h1>{title}</h1><p>{children}</p></div>;
}
export function FieldError({ id, children }: { id?: string; children?: ReactNode }) {
  return children ? <p id={id} role="alert" className="field-error">{children}</p> : null;
}
