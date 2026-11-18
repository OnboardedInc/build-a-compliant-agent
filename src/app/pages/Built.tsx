import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useBuilder } from "@/lib/builder";
import { AgentFace } from "@/components/AgentFace";
import { SiteMark } from "@/components/build/BuildLayout";
import { PartCard } from "@/components/build/PartCard";
export function Built() {
  const { builder } = useBuilder();
  if (!builder) return null;
  return <main className="built-page"><SiteMark /><div className="built-body"><div className="built-intro"><div className="built-avatar" role="img" aria-label={`${builder.agentName}, ${builder.company}'s screening agent`} style={{ background: builder.brand.primary }}><AgentFace face={builder.agentFace ?? 1} head={builder.brand.secondary} eye={builder.brand.primary} size={82} /></div><div className="built-heading"><span>{builder.company}'s screening agent</span><h1>{builder.agentName} is built</h1><p>Take a call as a candidate. {builder.agentName} asks your two questions, makes the offer, and Onboarded's forms open on the same call.</p></div><Link to="/call" className="primary-button built-cta">Take a test call<ArrowRight size={16} /></Link></div><ol className="built-parts" aria-label="What went into your agent"><PartCard title="Your brand" state="done" style={{ animationDelay: "450ms" }}>Logo and colours from {builder.website}.</PartCard><PartCard title="Your two questions" state="done" style={{ animationDelay: "900ms" }}>From your description, scored as {builder.questions.map(q => q.topic).join(" and ")}.</PartCard><PartCard title="A name and a face" state="done" style={{ animationDelay: "1350ms" }}>{builder.agentName}, with the voice candidates hear on the call.</PartCard><PartCard title="Compliance, by Onboarded" compliance state="done" style={{ animationDelay: "1800ms" }}>The forms the job and state require, each form's deadline, and a hire that is ready for work when they are done.</PartCard></ol></div></main>;
}
