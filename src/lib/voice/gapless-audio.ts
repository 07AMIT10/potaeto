/**
 * Gapless Web Audio API queue scheduler for incoming PCM audio chunks
 * with immediate interruption on barge-in.
 */

export interface GaplessAudioOptions {
  sampleRate?: number; // default 16000
  onEnded?: () => void;
  onInterrupted?: () => void;
  onError?: (err: Error) => void;
}

export class GaplessAudioPlayer {
  private audioContext: AudioContext | null = null;
  private nextPlayTime: number = 0;
  private activeSources: Set<AudioBufferSourceNode> = new Set();
  private options: GaplessAudioOptions = {};
  private isInterrupted: boolean = false;
  private totalEnqueuedChunks: number = 0;
  private finishedChunks: number = 0;

  constructor(options: GaplessAudioOptions = {}) {
    this.options = options;
  }

  private initAudioContext(): AudioContext {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioCtx();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
    return this.audioContext;
  }

  isPlaying(): boolean {
    return this.activeSources.size > 0;
  }

  getActiveSourceCount(): number {
    return this.activeSources.size;
  }

  getNextPlayTime(): number {
    return this.nextPlayTime;
  }

  /**
   * Enqueue a raw 16-bit PCM chunk (16kHz mono) to be played gaplessly.
   */
  enqueueChunk(chunk: ArrayBuffer | Uint8Array | Int16Array): void {
    if (this.isInterrupted) return;

    let int16Data: Int16Array;
    if (chunk instanceof Int16Array) {
      int16Data = chunk;
    } else if (chunk instanceof Uint8Array) {
      int16Data = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
    } else if (chunk instanceof ArrayBuffer) {
      int16Data = new Int16Array(chunk);
    } else {
      return;
    }

    if (int16Data.length === 0) return;

    const ctx = this.initAudioContext();
    const sampleRate = this.options.sampleRate || 16000;
    const numSamples = int16Data.length;

    // Convert Int16 [-32768, 32767] to Float32 [-1.0, 1.0]
    const audioBuffer = ctx.createBuffer(1, numSamples, sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < numSamples; i++) {
      channelData[i] = int16Data[i] / 32768.0;
    }

    // Schedule gapless playback
    const currentTime = ctx.currentTime;
    const startTime = Math.max(currentTime, this.nextPlayTime);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    source.start(startTime);
    this.nextPlayTime = startTime + audioBuffer.duration;
    this.activeSources.add(source);
    this.totalEnqueuedChunks++;

    source.onended = () => {
      this.activeSources.delete(source);
      this.finishedChunks++;
      if (this.activeSources.size === 0 && !this.isInterrupted) {
        this.options.onEnded?.();
      }
    };
  }

  /**
   * Barge-in: immediately halts playback, stops all scheduled audio sources,
   * resets the timeline, and triggers onInterrupted.
   */
  interrupt(): void {
    this.isInterrupted = true;

    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Source may already have ended
      }
    }
    this.activeSources.clear();
    this.nextPlayTime = 0;
    this.options.onInterrupted?.();
  }

  /**
   * Reset player state so it can accept new audio chunks.
   */
  reset(): void {
    this.interrupt();
    this.isInterrupted = false;
    this.totalEnqueuedChunks = 0;
    this.finishedChunks = 0;
  }

  /**
   * Close and dispose of audio context.
   */
  close(): void {
    this.interrupt();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }
  }
}

export interface StreamingTtsOptions {
  wsUrl?: string;
  voice?: string;
  onSentenceStart?: (index: number, text: string) => void;
  onSentenceEnd?: (index: number) => void;
  onDone?: () => void;
  onInterrupted?: () => void;
  onError?: (err: Error) => void;
}

/**
 * Client for Sentence-Streaming Piper TTS with gapless playback and barge-in.
 */
export class StreamingTtsClient {
  private player: GaplessAudioPlayer;
  private socket: WebSocket | null = null;
  private isSynthesizing = false;

  constructor(options: GaplessAudioOptions = {}) {
    this.player = new GaplessAudioPlayer({
      ...options,
      onInterrupted: () => {
        options.onInterrupted?.();
      },
    });
  }

  getPlayer(): GaplessAudioPlayer {
    return this.player;
  }

  private resolveWsUrl(customUrl?: string): string {
    if (customUrl) return customUrl;
    if (typeof window !== 'undefined') {
      const isTauri =
        window.location.origin.includes('tauri.localhost') ||
        window.location.origin.includes('tauri://');
      const coreUrl = isTauri
        ? 'http://127.0.0.1:8010'
        : localStorage.getItem('potaeto_core_url')?.replace(/\/+$/, '') || window.location.origin;
      const wsProto = coreUrl.startsWith('https') ? 'wss' : 'ws';
      const host = coreUrl.replace(/^https?:\/\//, '');
      return `${wsProto}://${host}/v1/voice/stream/tts`;
    }
    return 'ws://127.0.0.1:8010/v1/voice/stream/tts';
  }

  /**
   * Send text to be synthesized into sentence-streamed PCM audio.
   */
  async speak(text: string, options: StreamingTtsOptions = {}): Promise<void> {
    this.bargeIn();
    this.player.reset();
    this.isSynthesizing = true;

    const wsUrl = this.resolveWsUrl(options.wsUrl);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.socket = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'prompt',
            text,
            voice: options.voice || 'en_US-lessac-medium',
          })
        );
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Binary audio PCM chunk
          this.player.enqueueChunk(event.data);
        } else if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'sentence_start') {
              options.onSentenceStart?.(msg.sentence_index, msg.text);
            } else if (msg.type === 'sentence_end') {
              options.onSentenceEnd?.(msg.sentence_index);
            } else if (msg.type === 'done') {
              this.isSynthesizing = false;
              options.onDone?.();
              resolve();
            } else if (msg.type === 'interrupted') {
              this.isSynthesizing = false;
              options.onInterrupted?.();
              resolve();
            }
          } catch {
            // ignore malformed json
          }
        }
      };

      ws.onerror = () => {
        const err = new Error('TTS streaming WebSocket error');
        options.onError?.(err);
        this.isSynthesizing = false;
        reject(err);
      };

      ws.onclose = () => {
        this.isSynthesizing = false;
        resolve();
      };
    });
  }

  /**
   * Barge in immediately: halts client playback and signals server to cancel synthesis.
   */
  bargeIn(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: 'barge_in' }));
      } catch {
        // ignore
      }
    }
    this.player.interrupt();
    this.isSynthesizing = false;
  }

  stop(): void {
    this.bargeIn();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.player.close();
  }
}

export const streamingTts = new StreamingTtsClient();
