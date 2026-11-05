import { z } from 'zod';

export const platformKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const consolePlatformKey = (platform: string) => platform === 'chat_gpt' ? 'chatgpt' : platform;
export const localPlatformKey = (platform: string) => platform === 'chatgpt' ? 'chat_gpt' : platform;

/** Branding is a display fallback for saved answers, never an availability list. */
export function platformName(platform: string) {
  const names: Record<string, string> = { chat_gpt: 'ChatGPT', chatgpt: 'ChatGPT', gemini: 'Gemini', perplexity: 'Perplexity',
    ai_mode: 'Google AI Mode', google_ai_mode: 'Google AI Mode', google_ai_overview: 'Google AI Overview',
    claude: 'Claude', grok: 'Grok', deepseek: 'DeepSeek', copilot: 'Copilot', openrouter: 'OpenRouter' };
  return Object.hasOwn(names, platform) ? names[platform] : platform.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}
