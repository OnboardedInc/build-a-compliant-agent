import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Loader2 } from "lucide-react";
import { DEFAULT_BRAND, normalizeDomain, workEmailProblem, type Brand, type StartResponse } from "@shared/builder";
import { apiFetch, readAccess } from "@/lib/api";
import { humanHeaders } from "@/lib/human";
import { useBuilder } from "@/lib/builder";
import { useProblem } from "@/lib/useProblem";
import { BuildLayout, FieldError, PageHeading, StartOver, StepFooter } from "@/components/build/BuildLayout";
import { AgentPanel } from "@/components/build/AgentPanel";
import { CompanyLogo } from "@/components/build/PhonePreview";

export function Company() {
  const { builder, accept } = useBuilder();
  const [email, setEmail] = useState(builder?.email ?? "");
  const [company, setCompany] = useState(builder?.company ?? "");
  const [website, setWebsite] = useState(builder?.website ?? "");
  const [preview, setPreview] = useState<{ domain: string; brand: Brand } | null>(builder ? { domain: builder.website, brand: builder.brand } : null);
  const [finding, setFinding] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);
  const latestWebsite = useRef(website);
  latestWebsite.current = website;
  const lookup = useRef<{ domain: string; promise: Promise<Brand> } | null>(null);
  const problem = useProblem();
  const navigate = useNavigate();
  const domain = normalizeDomain(website);
  // With Google sign-in on, the work email is the signed-in address.
  useEffect(() => {
    if (builder) return;
    let cancelled = false;
    void readAccess().then(access => { if (!cancelled && access.wall && access.email) setEmail(current => current || access.email || ""); }).catch(() => {});
    return () => { cancelled = true; };
  }, [builder]);
  const brand = preview?.domain === domain ? preview.brand : DEFAULT_BRAND;
  const findBrand = async (value: string) => {
    const requested = normalizeDomain(value);
    if (!requested) { setFinding(false); setPreviewError(null); return; }
    const id = ++generation.current;
    setFinding(true); setPreviewError(null);
    if (lookup.current?.domain !== requested) lookup.current = { domain: requested, promise: humanHeaders("lookup").then(headers => apiFetch<Brand>("/api/brand/preview", { method: "POST", headers, body: JSON.stringify({ website: value }) })) };
    try {
      const found = await lookup.current.promise;
      if (id === generation.current && normalizeDomain(latestWebsite.current) === requested) setPreview({ domain: requested, brand: found });
    } catch (reason) {
      lookup.current = null;
      if (id === generation.current && normalizeDomain(latestWebsite.current) === requested) setPreviewError(reason instanceof Error ? reason.message : "The brand preview could not be loaded.");
    } finally { if (id === generation.current) setFinding(false); }
  };
  useEffect(() => {
    // An agent that already exists shows the brand it was built with: nothing is looked up again.
    if (builder) return;
    const timer = setTimeout(() => { void findBrand(website); }, 600);
    return () => { clearTimeout(timer); generation.current += 1; };
  }, [website]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (active.current) return;
    problem.clear();
    // An agent that already exists is kept: Continue goes on to its questions. "Reset agent" starts a new one.
    if (builder) { navigate(builder.verified ? "/questions" : "/check-email"); return; }
    const invalidEmail = workEmailProblem(email);
    setEmailError(invalidEmail);
    if (invalidEmail) { document.getElementById("bca-email")?.focus(); return; }
    active.current = true; setPending(true);
    try {
      const response = await apiFetch<StartResponse & { emailSent?: boolean }>("/api/builders", { method: "POST", headers: await humanHeaders("start"), body: JSON.stringify({ email, company, website }) });
      accept(response);
      navigate("/check-email", { state: { emailSent: response.emailSent } });
    } catch (reason) { problem.report(reason); }
    finally { active.current = false; setPending(false); }
  };
  const emailMessage = emailError ?? problem.field("email");
  return <BuildLayout step={1} panel={<AgentPanel step={1} brand={brand} company={company} website={preview?.domain === domain ? domain ?? "" : ""} />} footer={<StepFooter form="company-form" busy={pending} start={builder ? <StartOver label="Reset agent" className="back-button" /> : undefined} />}><PageHeading title="Build a screening agent that hires compliantly">{builder ? "This is the company your agent works for. Continue to change its questions, name or face. To use a different company, reset the agent." : "Start with your company. We find your logo and colours from your website, and your agent wears them."}</PageHeading><form id="company-form" className="builder-form" onSubmit={event => void submit(event)}>
    <div className="field"><label htmlFor="bca-email">Work email</label><input id="bca-email" name="email" type="email" autoComplete="email" required readOnly={!!builder} value={email} onChange={event => { setEmail(event.target.value); setEmailError(null); }} onBlur={() => { if (email) setEmailError(workEmailProblem(email)); }} aria-invalid={!!emailMessage} aria-describedby="email-hint email-error" /><span className="field-hint" id="email-hint">Work addresses only. Personal providers such as gmail.com and outlook.com are not accepted.</span><FieldError id="email-error">{emailMessage}</FieldError></div>
    <div className="field"><label htmlFor="bca-company">Company name</label><input id="bca-company" name="company" autoComplete="organization" required minLength={2} maxLength={80} readOnly={!!builder} value={company} onChange={event => setCompany(event.target.value)} aria-invalid={!!problem.field("company")} aria-describedby="company-error" /><FieldError id="company-error">{problem.field("company")}</FieldError></div>
    <div className="field"><label htmlFor="bca-site">Company website</label><input id="bca-site" name="website" type="text" inputMode="url" autoComplete="url" placeholder="company.com" required readOnly={!!builder} value={website} onChange={event => setWebsite(event.target.value)} onBlur={() => void findBrand(website)} aria-invalid={!!problem.field("website")} aria-describedby="website-error" /><FieldError id="website-error">{problem.field("website")}</FieldError></div>
    <div aria-live="polite">{finding && <p className="field-hint flex items-center gap-2"><Loader2 size={14} className="animate-spin" />Finding your logo and colours…</p>}{!finding && preview?.domain === domain && <div className="brand-result"><p><Check size={14} />{brand.source === "default" ? "Using a default brand for" : "Found on"} {domain}</p><div className="brand-swatches"><div><CompanyLogo key={brand.logoUrl} brand={brand} company={company} size={32} /><span><small>Logo</small><b>{brand.logoUrl ? "Found" : "Company initial"}</b></span></div>{([["Primary (darker)", brand.primary], ["Secondary (lighter)", brand.secondary]] as const).map(([label, color]) => <div key={label}><span className="swatch" style={{ background: color }} /><span><small>{label}</small><code>{color}</code></span></div>)}</div></div>}</div><FieldError>{previewError}</FieldError><FieldError>{problem.message}</FieldError>
  </form></BuildLayout>;
}
