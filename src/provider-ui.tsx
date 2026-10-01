import { Blocks, ChartNoAxesCombined, FilePenLine, MessagesSquare, Lightbulb, Globe, Network } from "lucide-react";
import type { Provider, Observation } from "../server/contracts";
import marks from "../brand/provider-marks.json";
export const providerOrder: Provider[] = ["chatgpt", "console", "dataforseo", "openrouter"];
export const providerLabels: Record<Provider, string> = { chatgpt: "ChatGPT", console: "SurfacedBy API", dataforseo: "DataForSEO", openrouter: "OpenRouter" };
export const consolePlatformCatalog = [
  { key: "chatgpt", name: "ChatGPT" }, { key: "perplexity", name: "Perplexity" },
  { key: "gemini", name: "Gemini" }, { key: "ai_mode", name: "Google AI Mode" },
  { key: "claude", name: "Claude" }, { key: "grok", name: "Grok" }, { key: "deepseek", name: "DeepSeek" },
];
export function platformLabel(platform: string) {
  return ({ chat_gpt: "ChatGPT", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", google_ai_mode: "Google AI Mode", google_ai_overview: "Google AI Overview", copilot: "Copilot", openrouter: "OpenRouter" } as Record<string, string>)[platform] ?? platform.replaceAll("_", " ");
}
export function retrievalLabel(answer: Observation) {
  if (answer.provider === "chatgpt" && answer.retrieval === "web_search")
    return answer.webSearchConfirmed === true ? "Web search confirmed" : "Web search requested, use unconfirmed";
  return answer.retrieval === "model_only" ? "Model-only answer" : "Provider-managed retrieval";
}
export function ProviderIcon({ provider, size = 22 }: { provider: string; size?: number }) {
  if (provider === "console") return <svg width={size} height={size} viewBox="0 0 20 26" fill="#172033" aria-hidden="true"><g transform="translate(-26.5 -85)"><path d="M33.624 87.341C33.934 87.28 33.797 87.253 34.066 87.341C33.912 87.769 33.174 88.277 32.919 88.676C30.198 92.929 32.525 95.667 36.936 96.581C40.386 97.264 45.19 99.477 44.59 103.819C43.565 111.239 33.216 111.611 29.045 106.732C28.429 105.841 28.078 105.017 27.595 104.052C29.166 103.592 30.099 103.023 31.526 102.555C31.841 103.839 32.662 104.944 33.802 105.615C36.013 106.896 41.232 106.427 40.224 102.875C39.528 100.42 33.848 100.207 31.574 98.885C26.109 95.709 27.827 88.995 33.624 87.341Z"/><path d="M33.366 93.459C33.404 93.709 33.401 93.621 33.358 93.872L33.241 93.875C32.646 93.217 32.618 92.15 32.761 91.323C32.98 90.021 33.731 88.867 34.833 88.14C37.786 86.187 42.438 87.817 44.237 90.63C44.412 90.95 44.568 91.155 44.579 91.515C44.242 91.895 41.287 93.415 40.666 93.725C40.408 93.715 40.481 93.763 40.296 93.655C38.999 90.536 34.369 89.783 33.366 93.459Z"/><path fill="#0b5ed7" d="M33.366 93.459C31.859 91.87 36.387 87.214 40.975 92.439L44.237 90.631C44.412 90.951 44.568 91.155 44.579 91.515C44.242 91.895 41.287 93.415 40.666 93.725C40.408 93.715 40.481 93.763 40.296 93.655C38.999 90.536 34.369 89.783 33.366 93.459Z"/></g></svg>;
  if (provider === "chatgpt" || provider === "chat_gpt" || provider.startsWith("openai/")) return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={marks.openai} /></svg>;
  if (provider === "dataforseo") return <ChartNoAxesCombined size={size} aria-hidden="true" />;
  if (provider === "openrouter") return <Network size={size} aria-hidden="true" />;
  if (["gemini", "perplexity", "claude", "ai_mode", "google_ai_mode", "grok", "deepseek"].includes(provider)) return <img src={"/platforms/" + (provider === "google_ai_mode" ? "ai_mode" : provider) + ".svg"} width={size} height={size} alt="" aria-hidden="true" />;
  return <Blocks size={size} aria-hidden="true" />;
}
export function Capabilities({ provider, consoleContent = false }: { provider: Provider; consoleContent?: boolean }) {
  const features = provider === "dataforseo" ? [[MessagesSquare, "AI answers"], [Globe, "Web citations"]] as const :
    provider === "console" ? [[MessagesSquare, "AI answers"], [Globe, "Web citations"], [Lightbulb, "Analysis & opportunities"], ...(consoleContent ? [[FilePenLine, "Content"] as const] : [])] as const :
    [[MessagesSquare, provider === "openrouter" ? "AI answers (API only)" : "AI answers"], [Lightbulb, "Analysis"], [FilePenLine, "Content"]] as const;
  return <div className="capability-list">{features.map(([Icon, label]) => <span key={label}><Icon size={14} />{label}</span>)}</div>;
}
export function providerOptions(connected: Record<string, boolean>, allowed = providerOrder) {
  return providerOrder.filter((provider) => allowed.includes(provider) && connected[provider]).map((provider) => ({ value: provider, label: providerLabels[provider], icon: <ProviderIcon provider={provider} size={18} /> }));
}
