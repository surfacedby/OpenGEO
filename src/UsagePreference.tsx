import { useEffect, useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { api } from "./api";
import identity from "../brand/identity.json";
import "./usage.css";

export function UsagePreference({ compact = false }: { compact?: boolean }) {
  const [enabled, setEnabled] = useState(false), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);
  useEffect(() => { let stopped = false; setError(""); void api<{ enabled: boolean }>("/settings/usage-sharing").then(value => { if (!stopped) { setEnabled(value.enabled); setReady(true); } }).catch(() => { if (!stopped) setError("This preference could not be loaded. Usage sharing stays unchanged."); }); return () => { stopped = true; }; }, [retry]);
  async function change(next: boolean) {
    setPendingValue(next); setBusy(true); setError("");
    try { const result = await api<{ enabled: boolean }>("/settings/usage-sharing", { enabled: next }, "PUT"); setEnabled(result.enabled); }
    catch {
      // A lost response can follow a committed preference; reconcile before
      // telling a user that their privacy choice was not saved.
      try {
        const current = await api<{ enabled: boolean }>("/settings/usage-sharing");
        setEnabled(current.enabled);
        if (current.enabled !== next) setError("The change was not saved. Try again.");
      } catch { setReady(false); setError("Usage sharing could not be confirmed. Keep the application running and try again."); }
    }
    finally { setPendingValue(null); setBusy(false); }
  }
  return <section className={compact ? "usage-preference compact" : "panel usage-preference"} aria-label="Usage sharing" aria-busy={busy}>
    {!compact && <div className="panel-heading"><h2><ShieldCheck size={17} />Help improve {identity.name}</h2></div>}
    <div className={compact ? undefined : "panel-padding"}>
      <label className="usage-choice"><input type="checkbox" checked={pendingValue ?? enabled} disabled={!ready || busy} onChange={event => void change(event.target.checked)} /><span>{compact ? "Help improve " + identity.name + " by sharing usage" : "Share usage to help improve " + identity.name}</span></label>
      <p className="small">Optional. No websites, prompts, content, account details or credentials.</p>
      {compact && <p className="small">Shared with SurfacedBy. You can turn this off anytime in Settings.</p>}
      {!compact && <details><summary><ChevronDown size={14} aria-hidden="true" />What is shared?</summary><p className="small">Daily activity, completed workflows, the providers used, app version and device type help us understand what works. A random installation identifier counts returning installations. SurfacedBy receives these records and keeps up to 90 days of activity. You can turn sharing off anytime; queued records and the local identifier are then removed. Previously accepted records expire with retention.</p></details>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {!ready && error && <button className="btn secondary" onClick={() => setRetry(value => value + 1)}>Try again</button>}
    </div>
  </section>;
}
