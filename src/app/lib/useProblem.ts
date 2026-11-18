import { useState } from "react";
import type { FieldError } from "@shared/builder";
import { ApiError } from "./api";
export function useProblem() {
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const clear = () => { setMessage(null); setErrors([]); };
  const report = (reason: unknown) => {
    setMessage(reason instanceof Error ? reason.message : "Something went wrong. Please try again.");
    setErrors(reason instanceof ApiError ? reason.errors : []);
  };
  return { message, errors, clear, report, field: (field: FieldError["field"]) => errors.find(error => error.field === field)?.message };
}
