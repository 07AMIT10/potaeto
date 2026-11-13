import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpeechPlayer } from './speech';

describe('SpeechPlayer', () => {
  let player: SpeechPlayer;

  beforeEach(() => {
    player = new SpeechPlayer();
  });

  afterEach(() => {
    player.stop();
    vi.restoreAllMocks();
  });

  it('returns false when text is empty or whitespace', async () => {
    const res = await player.speak('   ');
    expect(res).toBe(false);
  });

  it('uses Web Speech API when available and handles completion', async () => {
    let onEndCallback: (() => void) | null = null;
    const mockSpeak = vi.fn().mockImplementation((utterance) => {
      onEndCallback = utterance.onend;
      setTimeout(() => onEndCallback?.(), 10);
    });
    const mockCancel = vi.fn();

    vi.stubGlobal('speechSynthesis', {
      speak: mockSpeak,
      cancel: mockCancel,
      speaking: false,
    });

    vi.stubGlobal('SpeechSynthesisUtterance', class {
      text: string;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    });

    const res = await player.speak('Hello world');
    expect(res).toBe(true);
    expect(mockSpeak).toHaveBeenCalled();
  });

  it('falls back to server audio when Web Speech API fails or throws', async () => {
    vi.stubGlobal('speechSynthesis', {
      speak: vi.fn().mockImplementation((utterance) => {
        setTimeout(() => utterance.onerror?.(), 5);
      }),
      cancel: vi.fn(),
      speaking: false,
    });

    vi.stubGlobal('SpeechSynthesisUtterance', class {
      text: string;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    });

    const mockBlob = new Blob(['RIFF....WAVE'], { type: 'audio/wav' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    }));
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn().mockReturnValue('blob:test'),
      revokeObjectURL: vi.fn(),
    });

    let onEnded: (() => void) | null = null;
    vi.stubGlobal('Audio', class {
      src = '';
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play = vi.fn().mockImplementation(() => {
        setTimeout(() => this.onended?.(), 10);
        return Promise.resolve();
      });
      pause = vi.fn();
    });

    const res = await player.speak('Fallback test', { coreBaseUrl: 'http://127.0.0.1:8010' });
    expect(res).toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8010/v1/voice/synthesize', expect.any(Object));
  });

  it('cancels playback on stop()', () => {
    const mockCancel = vi.fn();
    vi.stubGlobal('speechSynthesis', {
      cancel: mockCancel,
      speaking: false,
    });

    player.stop();
    expect(mockCancel).toHaveBeenCalled();
    expect(player.isSpeaking()).toBe(false);
  });
});
