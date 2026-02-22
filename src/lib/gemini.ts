import { GoogleGenAI } from '@google/genai';

/** Get Gemini API key: server env first, then optional user key (for MVP we only use env). */
export function getGeminiApiKey(userKey?: string | null): string | null {
  const fromEnv =
    process.env.GOOGLE_GEMINI_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return userKey?.trim() || null;
}

/** Text/chat/script: default Gemini 2.5 Flash. Override with GEMINI_MODEL in .env.local. */
export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
}

/** Image generation: override with GEMINI_IMAGE_MODEL in .env.local if needed. */
export function getGeminiImageModel(): string {
  return process.env.GEMINI_IMAGE_MODEL?.trim() || 'gemini-2.0-flash-exp-image-generation';
}

/** TTS: override with GEMINI_TTS_MODEL in .env.local if needed. */
export function getGeminiTtsModel(): string {
  return process.env.GEMINI_TTS_MODEL?.trim() || 'gemini-2.5-flash-preview-tts';
}

export function createGeminiClient(apiKey: string) {
  return new GoogleGenAI({ apiKey });
}
