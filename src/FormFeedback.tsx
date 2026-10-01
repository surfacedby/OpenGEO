import { useEffect, useId, useRef, useState } from "react";
import { RequestError } from "./api";

/** Keep server validation attached to its controls, including fields inside custom selectors. */
export function useFormFeedback() {
  const [failure, setFailure] = useState<Error | null>(null);
  const id = useId();
  const fields = failure instanceof RequestError ? failure.fields : [];
  function setError(value: unknown) {
    setFailure(!value ? null : value instanceof Error ? value : new Error(String(value)));
  }
  function field(name: string, description?: string) {
    const matches = fields.flatMap((entry, index) => entry.path.includes(name) ? [id + "-" + index] : []);
    return {
      "aria-invalid": matches.length ? true as const : undefined,
      "aria-describedby": [description, ...matches].filter(Boolean).join(" ") || undefined,
    };
  }
  return { error: failure?.message ?? "", failure, setError, field, fields, id };
}

const labels: Record<string, string> = {
  domain: "Website", brand: "Brand name", aliases: "Brand aliases", competitors: "Competitor websites",
  prompts: "Questions", locale: "Language and region", knowledge: "Your expertise", model: "Model",
  provider: "Connection", platform: "Answer platform", maxCostUsd: "Run budget", monthlyBudgetUsd: "Monthly budget",
  topic: "Topic", revisionInstructions: "Revision instructions", maxPages: "Pages per audit",
  login: "API login", password: "API password", key: "API key", timezone: "Time zone", hour: "Time", weekday: "Day",
  amount: "Cost estimate", code: "Authorization code", frequency: "Frequency", kind: "Workflow", projectId: "Website",
};

export function FormFeedback({ feedback }: { feedback: ReturnType<typeof useFormFeedback> }) {
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => { if (feedback.failure) summary.current?.focus(); }, [feedback.failure]);
  if (!feedback.error) return null;
  return <div ref={summary} className="inline-error" role="alert" tabIndex={-1}>
    {feedback.fields.length ? <><p>Review the highlighted fields.</p><ul>{feedback.fields.map((entry, index) => {
      const key = [...entry.path].reverse().find(part => typeof part === "string") as string | undefined;
      const description = feedback.id + "-" + index;
      return <li id={description} key={index}><button type="button" className="text-button" onClick={() => {
        const control = [...document.querySelectorAll<HTMLElement>("[aria-describedby]")].find(element => element.getAttribute("aria-describedby")?.split(" ").includes(description));
        if (!control) return;
        for (let parent = control.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
        control.focus();
      }}>{key && labels[key] ? labels[key] + ": " : ""}{entry.message}</button></li>;
    })}</ul></> : feedback.error}
  </div>;
}
