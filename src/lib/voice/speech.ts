/**
 * Resilient multi-tier speech synthesis for Web, Tauri Desktop, and Android WebView.
 *
 * Tier 1: Browser/WebView native Web Speech API (`window.speechSynthesis`).
 * Tier 2: Core server-side fallback (`/v1/voice/synthesize` returning 16kHz WAV audio stream).
 */

export interface SpeechOptions {
  voice?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  coreBaseUrl?: string;
  authToken?: string;
}

export class SpeechPlayer {
  private activeAudio: HTMLAudioElement | null = null;
  private speaking = false;

  isSpeaking(): boolean {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      if (window.speechSynthesis.speaking) return true;
    }
    return this.speaking;
  }

  stop(): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore error on cancel
      }
    }
    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
        this.activeAudio.src = '';
      } catch {
        // Ignore error on audio pause
      }
      this.activeAudio = null;
    }
    this.speaking = false;
  }

  async speak(text: string, options: SpeechOptions = {}): Promise<boolean> {
    if (!text.trim()) return false;
    this.stop();
    this.speaking = true;

    // Try Tier 1: Web Speech API
    const webSpeechSuccess = await this.tryWebSpeech(text, options);
    if (webSpeechSuccess) {
      this.speaking = false;
      return true;
    }

    // Try Tier 2: Core Server Fallback
    try {
      const coreSuccess = await this.playServerAudio(text, options);
      return coreSuccess;
    } finally {
      this.speaking = false;
    }
  }

  private tryWebSpeech(text: string, options: SpeechOptions): Promise<boolean> {
    return new Promise((resolve) => {
      // In Tauri or non-speech environments, bypass Web Speech API immediately
      if (
        typeof window === 'undefined' ||
        !('speechSynthesis' in window) ||
        typeof SpeechSynthesisUtterance === 'undefined' ||
        window.location.origin.includes('tauri.localhost') ||
        window.location.origin.includes('tauri://')
      ) {
        resolve(false);
        return;
      }

      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = options.rate ?? 1.0;
        utterance.pitch = options.pitch ?? 1.0;
        utterance.volume = options.volume ?? 1.0;

        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            try {
              window.speechSynthesis.cancel();
            } catch {
              // ignore
            }
            resolve(false);
          }
        }, 15000);

        utterance.onend = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(true);
          }
        };

        utterance.onerror = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(false);
          }
        };

        window.speechSynthesis.speak(utterance);
      } catch {
        resolve(false);
      }
    });
  }

  private async playServerAudio(text: string, options: SpeechOptions): Promise<boolean> {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') {
      return false;
    }

    const baseUrl =
      options.coreBaseUrl ||
      (typeof window !== 'undefined'
        ? window.location.origin.includes('tauri.localhost') || window.location.origin.includes('tauri://')
          ? 'http://127.0.0.1:8010'
          : localStorage.getItem('potaeto_core_url')?.replace(/\/+$/, '') || ''
        : '');
    const url = `${baseUrl}/v1/voice/synthesize`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token =
      options.authToken ||
      (typeof window !== 'undefined' ? localStorage.getItem('potaeto_device_token') : null);
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text,
          voice: options.voice || 'en_US-lessac-medium',
        }),
      });

      if (!res.ok) {
        return false;
      }

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      this.activeAudio = audio;

      return new Promise((resolve) => {
        audio.onended = () => {
          URL.revokeObjectURL(objectUrl);
          this.activeAudio = null;
          resolve(true);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          this.activeAudio = null;
          resolve(false);
        };
        audio.play().catch(() => {
          URL.revokeObjectURL(objectUrl);
          this.activeAudio = null;
          resolve(false);
        });
      });
    } catch {
      return false;
    }
  }
}

export const speechPlayer = new SpeechPlayer();
