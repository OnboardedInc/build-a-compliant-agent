import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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
import { SignIn } from "./pages/SignIn";
import { APP_BASE, readAccess, signOut, type AccessState } from "./lib/api";

const AccessContext = createContext<(AccessState & { signOut: () => Promise<void> }) | null>(null);
export function useAccess() {
  const access = useContext(AccessContext);
  if (!access) throw new Error("AccessGate is missing.");
  return access;
}
function AccessGate({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<AccessState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    const read = (requireSignIn = false) => {
      const version = ++revision.current;
      setError(null);
      if (requireSignIn) setAccess((previous) => previous ? { ...previous, wall: true, email: null } : null);
      void readAccess().then((next) => {
        if (active && version === revision.current) setAccess(requireSignIn ? { ...next, email: null } : next);
      }).catch((reason: unknown) => {
        if (active && version === revision.current) setError(reason instanceof Error ? reason.message : "Sign-in could not be checked.");
      });
    };
    const required = () => read(true);
    window.addEventListener("bca-sign-in-required", required);
    read();
    return () => { active = false; window.removeEventListener("bca-sign-in-required", required); };
  }, [attempt]);
  if (error) return <main className="status-page"><p role="alert">{error}</p><button onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Try again</button></main>;
  if (!access) return <main className="status-page"><Loader2 className="animate-spin" /><p role="status">Loading your agent…</p></main>;
  const accept = (next: AccessState) => { revision.current += 1; setAccess(next); };
  const logout = async () => { await signOut(); revision.current += 1; setAccess((previous) => previous ? { ...previous, email: null } : null); };
  return <AccessContext.Provider value={{ ...access, signOut: logout }}>
    {!access.wall || access.email ? children : <SignIn access={access} onSignedIn={accept} />}
  </AccessContext.Provider>;
}

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
function CompanyRoute() {
  const { token } = useBuilder();
  return <Company key={token ?? "new"} />;
}
function RouteEffects() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); document.title = "Build a compliant agent"; }, [pathname]);
  return null;
}
function BuilderApp() {
  return <BrowserRouter basename={APP_BASE || undefined}><BuilderProvider><RouteEffects /><Routes><Route path="/" element={<Guard step={1}><CompanyRoute /></Guard>} /><Route path="/check-email" element={<Guard step={2}><CheckEmail /></Guard>} /><Route path="/verify" element={<Verify />} /><Route path="/questions" element={<Guard step={3}><Questions /></Guard>} /><Route path="/name" element={<Guard step={4}><Name /></Guard>} /><Route path="/built" element={<Guard step={5}><Built /></Guard>} /><Route path="/call" element={<Guard step={5}><Call /></Guard>} /><Route path="/i/:token" element={<CandidateCall />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></BuilderProvider></BrowserRouter>;
}
export default function App() {
  return <AccessGate><BuilderApp /></AccessGate>;
}
