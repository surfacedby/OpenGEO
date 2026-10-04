import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowUpRight, CalendarClock, Check, Database, FilePenLine, KeyRound, Link, Plus, Settings, ShieldCheck, X, LogOut, RefreshCw } from "lucide-react";
import { api } from "./api";
import { BackupControls, ScheduleControls } from "./WorkflowControls";
import { Select } from "./Select";
import { FormFeedback, useFormFeedback } from "./FormFeedback";
import { Capabilities, ProviderIcon, providerLabels, providerOrder, consolePlatformCatalog } from "./provider-ui";
import identity from "../brand/identity.json";
import { UsagePreference } from "./UsagePreference";
import { WebsiteIconPreference } from "./WebsiteIconPreference";
import "./setup-refinements.css";
import "./connections.css";
import type { Provider } from "../server/contracts";
export type ChatGPTProfiles = { active: string | null; welcome?: boolean; profiles: { id: string; email: string; label?: string; sharing: boolean }[] };
type Run = (f: () => Promise<unknown>) => Promise<void>;
const tabs = [["Connections", Link], ["Schedules", CalendarClock], ["Data & privacy", Database], ["About", Settings]] as const;
const descriptions = {
  chatgpt: "Connect your ChatGPT subscription to track AI visibility, find improvements and create content.",
  console: "See your visibility across AI search, understand what holds you back and get prioritized improvements through one connection.",
  dataforseo: "Collect AI answers and citations. Pair with OpenRouter to turn your results into analysis and content.",
  openrouter: "Analyze your DataForSEO results and create content with your choice of AI model.",
};
export function ConnectionSettings({ connected, profiles, run: execute, variant = "settings", provider = "chatgpt", connectionsRequest = 0, beforeConnect }: { connected: Record<string, boolean>; profiles: ChatGPTProfiles; run: Run; variant?: "settings" | "onboarding"; provider?: Provider; connectionsRequest?: number; beforeConnect?: () => Promise<void> }) {
  const [tab, setTab] = useState<string>("Connections"), [expanded, setExpanded] = useState<Provider | null>(null),
    [pending, setPending] = useState<any>(null), [notice, setNotice] = useState(""),
    [consolePlatforms, setConsolePlatforms] = useState<{ key: string; name: string }[]>([]), [capabilityError, setCapabilityError] = useState(""),
    [loadingCapabilities, setLoadingCapabilities] = useState(false), [capabilityRevision, setCapabilityRevision] = useState(0), [busy, setBusy] = useState(false),
    [openingProvider, setOpeningProvider] = useState<Provider | null>(null),
    [showAllPlatforms, setShowAllPlatforms] = useState(false), [consoleContent, setConsoleContent] = useState(false);
  const mutationPending = useRef(false);
  const feedback = useFormFeedback();
  useEffect(() => { setTab("Connections"); }, [connectionsRequest]);
  async function run(action: () => Promise<unknown>) {
    if (mutationPending.current) return;
    mutationPending.current = true; setBusy(true);
    setNotice(""); feedback.setError("");
    try { await execute(async () => {
      try { return await action(); }
      catch (error) { feedback.setError(error); }
    }); } finally { mutationPending.current = false; setBusy(false); }
  }
  useEffect(() => {
    setConsolePlatforms([]); setConsoleContent(false); setCapabilityError("");
    if (!connected.console) { setLoadingCapabilities(false); return; }
    let stopped = false;
    setLoadingCapabilities(true);
    void api("/providers/console/capabilities").then((result) => {
      if (!stopped) { setConsolePlatforms((result.platforms ?? []).filter((platform: any) => platform.enabled)); setConsoleContent(result.content_available === true && result.operations?.includes("content")); setCapabilityError(""); }
    }).catch(() => { if (!stopped) setCapabilityError("Platform availability could not be checked."); }).finally(() => { if (!stopped) setLoadingCapabilities(false); });
    return () => { stopped = true; };
  }, [connected.console, capabilityRevision]);
  function connect(provider: "chatgpt" | "openrouter", addAccount = false, headless = false) {
    void run(async () => {
      setOpeningProvider(provider);
      try {
      await beforeConnect?.();
      const auth = await api("/connections/" + provider + "/start", { ...(provider === "chatgpt" && !addAccount && (profiles.active ?? profiles.profiles.at(-1)?.id) ? { profileId: profiles.active ?? profiles.profiles.at(-1)?.id } : {}), headless });
      setPending({ ...auth, provider });
      window.open(auth.url, "_blank", "noopener,noreferrer");
      } finally { setOpeningProvider(null); }
    });
  }
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    const check = async () => {
      try {
        const result = await api("/connections/" + pending.provider + "/status?state=" + encodeURIComponent(pending.state));
        if (stopped || result.status === "pending") return;
        setPending(null);
        setNotice(result.status === "connected" ? providerLabels[pending.provider as Provider] + " connected." : result.status === "identity" ? "Signed in, but ChatGPT plan access was not enabled. Reconnect and review the permissions." : result.status === "expired" ? "This sign-in expired. Start a new connection." : "Sign-in did not complete. Your previous connection was kept; try again.");
        if (result.status === "connected" || result.status === "identity") await execute(async () => {});
      } catch { /* A temporary local connection failure must not close a pending sign-in. */ }
    };
    void check();
    const timer = setInterval(() => void check(), 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [pending]);
  return <>
    {variant === "settings" && <div className="settings-tabs" role="tablist" aria-label="Settings sections">{tabs.map(([label, Icon]) => <button role="tab" aria-selected={tab === label} aria-controls="settings-content" id={"settings-" + label.replaceAll(" ", "-")} tabIndex={tab === label ? 0 : -1} key={label} onClick={() => setTab(label)} onKeyDown={(event) => {
      const index = tabs.findIndex(([name]) => name === tab);
      if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = tabs[event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length][0]; setTab(next); document.getElementById("settings-" + next.replaceAll(" ", "-"))?.focus(); }
    }}><Icon size={16} />{label}</button>)}</div>}
    <div id="settings-content" role={variant === "settings" ? "tabpanel" : undefined} aria-labelledby={variant === "settings" ? "settings-" + tab.replaceAll(" ", "-") : undefined} className={variant === "onboarding" ? "setup-connections" : undefined}>
      {tab === "Connections" && <>
        {variant === "settings" && <div className="connection-intro"><h2>Your connections</h2><p>Use ChatGPT, connect SurfacedBy, or pair DataForSEO with OpenRouter.</p></div>}
        <FormFeedback feedback={feedback} />
        {notice && <div className={"alert " + (notice.includes(" connected.") ? "connection-notice-success" : "")} role="status">{notice}<button aria-label="Dismiss notice" onClick={() => setNotice("")}><X size={16} /></button></div>}
        {pending && <section className="panel" aria-label="Pending provider connection"><div className="panel-padding"><h2>Finish connecting {providerLabels[pending.provider as Provider]}</h2><p className="small">Complete sign-in in your browser. This workspace updates when it succeeds.</p><a className="secondary" href={pending.url} target="_blank" rel="noreferrer">Open sign-in <ArrowUpRight size={14} /></a>{pending.headless && <form onSubmit={(event) => { event.preventDefault(); const code = new FormData(event.currentTarget).get("code"); void run(async () => { await api("/connections/openrouter/finish", { state: pending.state, code }); setPending(null); }); }}><label>Authorization code<input name="code" {...feedback.field("code")} autoComplete="off" required /></label><button className="primary">Complete connection</button></form>}</div></section>}
        <div className="provider-grid">{(variant === "onboarding" ? provider === "dataforseo" || provider === "openrouter" ? ["dataforseo", "openrouter"] as Provider[] : [provider] : providerOrder).map((provider) => <Fragment key={provider}>{provider === "dataforseo" && <div className="connection-pair-summary"><div><ProviderIcon provider="dataforseo" /><Plus size={14} /><ProviderIcon provider="openrouter" /></div><p><strong>DataForSEO + OpenRouter</strong><span>Measurements + analysis and content</span></p><span className="pair-state">{connected.dataforseo && connected.openrouter ? "Both connected" : connected.dataforseo ? "Add OpenRouter" : connected.openrouter ? "Add DataForSEO" : "Connect both for the full workflow"}</span></div>}<section className={"provider-card " + provider}>
          <div className="provider-card-heading"><div className="provider-avatar"><ProviderIcon provider={provider} size={28} /></div><div><h2>{providerLabels[provider]}</h2><span className="small">{provider === "chatgpt" ? "Your subscription" : provider === "console" ? "Managed measurement & insights" : provider === "dataforseo" ? "Direct measurement" : "Your model choice"}</span></div><span className={"connection-status " + (connected[provider] ? "is-connected" : "")}>{connected[provider] && <Check size={13} />}{connected[provider] ? "Connected" : "Not connected"}</span></div>
          <p className="provider-description">{descriptions[provider]}</p>
          <Capabilities provider={provider} consoleContent={consoleContent} />
          <div className="platform-list" aria-label={providerLabels[provider] + " supported platforms"}>
            {(provider === "chatgpt" ? [{ key: "chat_gpt", name: "ChatGPT only" }] : provider === "dataforseo" ? [{ key: "chat_gpt", name: "ChatGPT" }, { key: "gemini", name: "Gemini" }, { key: "perplexity", name: "Perplexity" }] : provider === "console" ? (connected.console ? consolePlatforms : showAllPlatforms ? consolePlatformCatalog : consolePlatformCatalog.slice(0, 3)) : []).map((platform) => <span key={platform.key}><ProviderIcon provider={platform.key} size={15} />{platform.name}</span>)}
            {provider === "console" && !connected.console && <button className="platform-more" aria-expanded={showAllPlatforms} onClick={() => setShowAllPlatforms(value => !value)}><Plus size={13} />{showAllPlatforms ? "Show less" : "4 more"}</button>}
            {provider === "console" && connected.console && !consolePlatforms.length && !capabilityError && <span>{loadingCapabilities ? "Checking availability..." : "No platforms are currently enabled"}</span>}
            {provider === "openrouter" && <span><ProviderIcon provider="openrouter" size={15} />Choose from available models after connecting</span>}
          </div>
          {provider === "console" && capabilityError && <div className="button-row"><p role="status" className="small">{capabilityError}</p><button className="text-button" disabled={loadingCapabilities} onClick={() => setCapabilityRevision(value => value + 1)}>Retry platform check</button></div>}
          {provider === "console" && connected.console && !consoleContent && !loadingCapabilities && !capabilityError && <p className="provider-availability">Content is not available on this connection yet.</p>}
          <div className="provider-footer"><small>{provider === "chatgpt" ? "Plus or Pro plan required. Your plan limits apply." : provider === "console" ? "Pay as you go." : provider === "dataforseo" ? "DataForSEO usage charges apply." : "Pay for the model usage you choose."}</small>
            <button disabled={busy} className={provider === "chatgpt" ? "primary" : "secondary"} onClick={() => { feedback.setError(""); provider === "chatgpt" && !connected.chatgpt ? connect("chatgpt") : setExpanded(expanded === provider ? null : provider); }}><KeyRound size={14} />{connected[provider] ? "Manage" : provider === "chatgpt" ? openingProvider === provider ? "Opening sign-in..." : "Continue with ChatGPT" : "Connect"}</button></div>
          {expanded === provider && <div className="provider-config">
            {provider === "chatgpt" ? <>
              <div className="account-summary"><span className="account-summary-icon"><ProviderIcon provider="chatgpt" size={23} /></span><div><strong>{profiles.profiles.find(profile => profile.id === profiles.active)?.email ?? "Your ChatGPT account"}</strong><small>{connected.chatgpt ? "Ready for questions, insights and content" : "Reconnect to enable your ChatGPT plan"}</small></div></div>
              {profiles.profiles.length > 1 && <label>Use this account<Select disabled={busy} searchable={false} label="ChatGPT account" value={profiles.active ?? ""} options={profiles.profiles.map(profile => ({ value: profile.id, label: profile.email, detail: profile.sharing ? "Plan connected" : "Needs reconnection", icon: <ProviderIcon provider="chatgpt" size={18} /> }))} onChange={(id) => void run(() => api("/connections/chatgpt/select", { id }))} /></label>}
              <div className="account-actions"><a className="secondary" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">View plan usage <ArrowUpRight size={14} /></a><button disabled={busy} className="secondary" onClick={() => connect("chatgpt")}><RefreshCw size={14} />Reconnect</button><button disabled={busy} className="secondary" onClick={() => connect("chatgpt", true)}><Plus size={14} />Add another account</button>
                {connected.chatgpt && <button disabled={busy} className="secondary account-disconnect" onClick={() => void run(async () => { const result = await api("/providers/chatgpt", undefined, "DELETE"); if (!result.revoked) setNotice("Disconnected locally. Remote revocation was not confirmed; review this connection in ChatGPT Settings."); })}><LogOut size={14} />Disconnect</button>}</div>
            </> : <>
              {provider === "openrouter" && <div className="button-row"><button disabled={busy} className="primary" onClick={() => connect("openrouter")}>Connect account</button><button disabled={busy} className="text-button" onClick={() => connect("openrouter", false, true)}>Use an authorization code</button></div>}
              {provider === "console" ? <ConsoleKeySetup connected={Boolean(connected.console)} run={run} disabled={busy} feedback={feedback} /> : <CredentialForm provider={provider} connected={Boolean(connected[provider])} run={run} disabled={busy} feedback={feedback} />}
              {provider === "dataforseo" && connected.dataforseo && <form onSubmit={(event) => { event.preventDefault(); void run(() => api("/settings/measurement-estimate", { amount: Number(new FormData(event.currentTarget).get("estimate")) }, "PUT")); }}><label>Spending estimate per answer (USD)<input name="estimate" {...feedback.field("amount")} type="number" min="0.001" step="0.001" required /></label><p className="small">Set this from your DataForSEO pricing before your first check.</p><button className="secondary">Save estimate</button></form>}
            </>}
          </div>}
        </section></Fragment>)}</div>
        {variant === "settings" && <p className="connection-privacy"><ShieldCheck size={16} />Credentials stay encrypted on this installation.</p>}
      </>}
      {tab === "Schedules" && <ScheduleControls connected={connected} run={run} />}
      {tab === "Data & privacy" && <><UsagePreference /><WebsiteIconPreference /><BackupControls run={run} /><section className="panel"><div className="panel-padding"><h2>Your data stays under your control</h2><p>Projects, observations and drafts are stored locally. Credentials are excluded from exports. You can turn usage sharing off anytime. Selected provider calls send the task inputs needed for that operation.</p></div></section></>}
      {tab === "About" && <section className="panel"><div className="about-product"><img src="/logo.svg" width="56" height="56" alt="" /><h2>{identity.name}</h2><p>{identity.tagline}</p><p>Free, open source software, with no artificial project limits.</p><small>Maintained by SurfacedBy. Managed services are optional.</small></div></section>}
    </div>
  </>;
}
function ConsoleKeySetup({ connected, ...formProps }: Omit<Parameters<typeof CredentialForm>[0], "provider">) {
  const [path, setPath] = useState<"existing" | "create" | null>(null);
  if (!connected && !path) return <div className="console-key-guide"><h3>Do you have a SurfacedBy API key?</h3><div className="button-row"><button className="secondary" onClick={() => setPath("existing")}><KeyRound size={15} />I have a key</button><a className="primary" href="https://console.surfacedby.com/keys" target="_blank" rel="noreferrer" onClick={() => setPath("create")}>Create a key <ArrowUpRight size={15} /></a></div></div>;
  return <div className="console-key-guide">{!connected && <><h3>{path === "create" ? "Bring your key back here" : "Connect with your key"}</h3>{path === "create" && <p className="small">Sign in or create an account in SurfacedBy Console, then create an API key. Keep this window open and paste the key below.</p>}</>}<CredentialForm {...formProps} provider="console" connected={connected} />{!connected && <button className="text-button" onClick={() => setPath(null)}>Back to key options</button>}</div>;
}
function CredentialForm({ provider, connected, run, disabled, feedback }: { provider: "openrouter" | "dataforseo" | "console"; connected: boolean; run: Run; disabled: boolean; feedback: ReturnType<typeof useFormFeedback> }) {
  const [busy, setBusy] = useState(false);
  return <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget, data = new FormData(form); setBusy(true); void run(async () => { await api("/providers", { provider, ...(provider === "dataforseo" ? { login: data.get("login"), password: data.get("password") } : { key: data.get("key") }) }, "PUT"); form.reset(); }).finally(() => setBusy(false)); }}>
    {provider === "dataforseo" ? <div className="form-grid"><label>API login<input name="login" {...feedback.field("login")} autoComplete="off" required /></label><label>API password<input name="password" {...feedback.field("password")} type="password" autoComplete="new-password" required /></label></div> : <label>{provider === "openrouter" ? "Or use an existing API key" : "API key"}<input name="key" {...feedback.field("key")} type="password" autoComplete="new-password" required /></label>}
    <div className="button-row"><button className="secondary" disabled={busy || disabled}>{busy ? "Verifying connection..." : "Verify & connect"}</button>{connected && <button className="text-button danger" disabled={busy || disabled} type="button" onClick={() => void run(() => api("/providers/" + provider, undefined, "DELETE"))}>Disconnect</button>}</div>
  </form>;
}
