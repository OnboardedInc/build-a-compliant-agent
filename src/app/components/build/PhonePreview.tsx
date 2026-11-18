import { useState } from "react";
import type { Brand } from "@shared/builder";
import { AgentFace } from "../AgentFace";
export function CompanyLogo({ brand, company, size = 22 }: { brand: Brand; company: string; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  return brand.logoUrl && failed !== brand.logoUrl ? <img className="company-logo" src={brand.logoUrl} alt="" width={size} height={size} onError={() => setFailed(brand.logoUrl)} /> : <span aria-hidden="true" className="company-initial" style={{ width: size, height: size, background: brand.secondary, color: brand.primary }}>{company.slice(0, 1).toUpperCase() || "C"}</span>;
}
export function PhonePreview({ brand, company, name, face }: { brand: Brand; company: string; name?: string | null; face?: number | null }) {
  const employer = company || "Your company";
  return <div className="phone-preview" role="img" aria-label={`Preview of ${name || "your agent"} for ${employer}`} style={{ background: brand.primary, color: "#FFFFFF" }}><div className="preview-company"><CompanyLogo brand={brand} company={employer} /><span>{employer}</span></div><div className="preview-face">{face ? <AgentFace face={face} head={brand.secondary} eye={brand.primary} /> : <span className="face-placeholder" />}</div>{name ? <strong className="preview-name">{name}</strong> : <span className="name-placeholder" />}<span className="preview-subtitle">AI interviewer for {employer}</span><div className="preview-wave" aria-hidden="true">{[10, 22, 34, 18, 28, 38, 20, 12].map((height, i) => <span key={i} style={{ height, background: brand.secondary }} />)}</div>{name && <p className="preview-greeting">Hi, I'm {name}, the AI interviewer for {employer}. Ready to start?</p>}<span className="preview-start" style={{ background: brand.secondary, color: brand.primary }}>Start the interview</span></div>;
}
