import { useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { BuilderProvider, useBuilder } from "./lib/builder";
import type { BuildStep } from "@shared/builder";
import { Company } from "./pages/Company";
import { CheckEmail } from "./pages/CheckEmail";
import { Verify } from "./pages/Verify";
import { Questions } from "./pages/Questions";
import { Name } from "./pages/Name";
import { Built } from "./pages/Built";
import { Call, CandidateCall } from "./pages/Call";

const rank: Record<BuildStep, number> = { company: 1, email: 2, questions: 3, name: 4, built: 5 };
const route: Record<BuildStep, string> = { company: "/", email: "/check-email", questions: "/questions", name: "/name", built: "/name" };
function Guard({ step, children }: { step: number; children: ReactNode }) {
  const { token, builder, loading, error, retry } = useBuilder();
  if (!token && step > 1) return <Navigate to="/" replace />;
  if (loading) return <main className="status-page"><Loader2 className="animate-spin" /><p role="status">Loading your agent…</p></main>;
  if (token && !builder) return <main className="status-page"><p role="alert">{error ?? "Your agent could not be loaded."}</p><button className="primary-button" onClick={retry}>Try again</button></main>;
  if (builder && !builder.verified && step > 2) return <Navigate to="/check-email" replace />;
  if (builder && step > rank[builder.step]) return <Navigate to={route[builder.step]} replace />;
  if (builder && step >= 5 && !builder.built) return <Navigate to="/name" replace />;
  return children;
}
function RouteEffects() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); document.title = "Build a compliant agent"; }, [pathname]);
  return null;
}
export default function App() {
  return <BrowserRouter><BuilderProvider><RouteEffects /><Routes><Route path="/" element={<Guard step={1}><Company /></Guard>} /><Route path="/check-email" element={<Guard step={2}><CheckEmail /></Guard>} /><Route path="/verify" element={<Verify />} /><Route path="/questions" element={<Guard step={3}><Questions /></Guard>} /><Route path="/name" element={<Guard step={4}><Name /></Guard>} /><Route path="/built" element={<Guard step={5}><Built /></Guard>} /><Route path="/call" element={<Guard step={5}><Call /></Guard>} /><Route path="/i/:token" element={<CandidateCall />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></BuilderProvider></BrowserRouter>;
}
