import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Mail } from "lucide-react";
import { useBuilder } from "@/lib/builder";
import { apiFetch } from "@/lib/api";
import { useProblem } from "@/lib/useProblem";
import { AgentPanel } from "@/components/build/AgentPanel";
import { BuildLayout, FieldError, PageHeading, StepFooter } from "@/components/build/BuildLayout";

export function CheckEmail() {
  const { builder, refresh } = useBuilder();
  const navigate = useNavigate();
  const location = useLocation();
  const [pending, setPending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [sent, setSent] = useState<boolean | null>((location.state as { emailSent?: boolean } | null)?.emailSent ?? null);
  const acting = useRef(false);
  const problem = useProblem();
  const [pollError, setPollError] = useState<string | null>(null);
  useEffect(() => {
    if (builder?.verified) { navigate("/questions", { replace: true }); return; }
    let stopped = false;
    let reading = false;
    const timer = setInterval(() => {
      if (reading) return;
      reading = true;
      void refresh().then(next => { if (!stopped) { setPollError(null); if (next.verified) navigate("/questions", { replace: true }); } }).catch(reason => { if (!stopped) setPollError(reason instanceof Error ? reason.message : "Could not check your email confirmation. Retrying…"); }).finally(() => { reading = false; });
    }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [builder?.verified, refresh, navigate]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  const resend = async () => {
    if (acting.current) return;
    acting.current = true; setPending(true); problem.clear();
    try {
      const response = await apiFetch<{ emailSent?: boolean }>("/api/me/verify/resend", { method: "POST" });
      setSent(response.emailSent ?? true); setCooldown(30); await refresh();
    } catch (reason) { problem.report(reason); }
    finally { acting.current = false; setPending(false); }
  };
  return <BuildLayout step={2} panel={<AgentPanel step={2} builder={builder} />} footer={<StepFooter back="/" disabled />}><span className="email-icon"><Mail size={22} /></span><PageHeading title="Confirm your email">{sent === false ? "We couldn't send the confirmation email to " : "We sent a one-time link to "}<strong>{builder?.email}</strong>. {sent === false ? "Try sending again below." : "Open it on any device and this page carries on. The link works once."}</PageHeading><div className="email-wait"><span role="status"><i className="wait-dot" />Waiting for the link to be opened</span><button type="button" className="text-button" disabled={pending || cooldown > 0} onClick={() => void resend()} aria-busy={pending}>{pending ? "Sending…" : cooldown ? `Send again in ${cooldown}s` : "Send again"}</button></div>{sent !== null && <p className="small-copy" role="status">{sent ? "The confirmation link has been sent. Check your inbox and spam folder." : "Try sending again to receive your link."}</p>}<FieldError>{problem.message ?? pollError}</FieldError><p className="small-copy">Your company, logo and colours are saved. You pick up at the questions as soon as the link is opened. <Link to="/" style={{ fontWeight: 600 }}>Use a different email</Link></p>{builder?.devVerifyUrl && <div className="development-box"><strong>Local development</strong><br /><a href={builder.devVerifyUrl}>Open the one-time confirmation link</a></div>}</BuildLayout>;
}
