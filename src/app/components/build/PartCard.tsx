import type { ReactNode, CSSProperties } from "react";
import { Check } from "lucide-react";
export function PartCard({ title, children, state = "todo", compliance = false, style }: { title: string; children: ReactNode; state?: "done" | "now" | "todo"; compliance?: boolean; style?: CSSProperties }) {
  return <li className={`part-card ${state} ${compliance ? "compliance" : ""}`} style={style}><span className="part-tick" aria-hidden="true">{state === "done" && <Check size={12} strokeWidth={3.4} />}</span><div><strong>{title}</strong><p>{children}</p></div></li>;
}
