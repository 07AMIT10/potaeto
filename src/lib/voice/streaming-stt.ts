/**
 * Streaming Speech-to-Text client capturing microphone audio via Web Audio API,
 * downsampling to 16kHz 16-bit mono PCM, and streaming over WebSocket to `/v1/voice/stream/stt`.
 */

export interface StreamingSttOptions {
  wsUrl?: string;
  authToken?: string;
  sampleRate?: number;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (err: Error) => void;
  onStateChange?: (state: 'idle' | 'connecting' | 'listening' | 'stopping') => void;
}

/**
 * Downsample arbitrary sample rate audio to 16kHz 16-bit mono PCM.
 */
export function downsampleTo16kMono(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate: number = 16000
): Int16Array {
  if (inputSampleRate === targetSampleRate) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
    }
    return output;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Int16Array(newLength);

  let offsetResult = 0;
  let offsetInput = 0;

  while (offsetResult < output.length) {
    const nextOffsetInput = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetInput; i < nextOffsetInput && i < input.length; i++) {
      accum += input[i];
      count++;
    }
    const sample = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    output[offsetResult] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    offsetResult++;
    offsetInput = nextOffsetInput;
  }

  return output;
}

export class StreamingSttClient {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private workletNode: AudioNode | null = null;
  private socket: WebSocket | null = null;
  private state: 'idle' | 'connecting' | 'listening' | 'stopping' = 'idle';
  private options: StreamingSttOptions = {};

  getState(): 'idle' | 'connecting' | 'listening' | 'stopping' {
    return this.state;
  }

  isListening(): boolean {
    return this.state === 'listening';
  }

  private setState(newState: 'idle' | 'connecting' | 'listening' | 'stopping') {
    this.state = newState;
    this.options.onStateChange?.(newState);
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
      return `${wsProto}://${host}/v1/voice/stream/stt`;
    }
    return 'ws://127.0.0.1:8010/v1/voice/stream/stt';
  }

  async start(options: StreamingSttOptions = {}): Promise<void> {
    if (this.state !== 'idle') {
      await this.stop();
    }

    this.options = options;
    this.setState('connecting');

    const wsUrl = this.resolveWsUrl(options.wsUrl);

    try {
      // 1. Establish WebSocket
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          this.socket = ws;
          resolve();
        };

        ws.onerror = (ev) => {
          const err = new Error('WebSocket connection to voice streaming endpoint failed');
          options.onError?.(err);
          reject(err);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'partial') {
              this.options.onPartial?.(data.text);
            } else if (data.type === 'final') {
              this.options.onFinal?.(data.text);
            } else if (data.type === 'error') {
              this.options.onError?.(new Error(data.error));
            }
          } catch {
            // Non-JSON frames ignored
          }
        };

        ws.onclose = () => {
          if (this.state !== 'idle') {
            this.cleanup();
            this.setState('idle');
          }
        };
      });

      // 2. Capture microphone stream
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone access is not supported in this environment');
      }

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // 3. Setup Web Audio pipeline
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioCtx();
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      const inputRate = this.audioContext.sampleRate;

      // Handle raw float chunks -> downsample to 16kHz Int16 PCM -> send over WS
      const handleAudioChunk = (floatSamples: Float32Array) => {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        const pcm16 = downsampleTo16kMono(floatSamples, inputRate, options.sampleRate || 16000);
        if (pcm16.length > 0) {
          this.socket.send(pcm16.buffer);
        }
      };

      // Try AudioWorklet first, fall back to ScriptProcessorNode
      let workletInitialized = false;
      if (this.audioContext.audioWorklet?.addModule) {
        try {
          const workletCode = `
            class PcmCaptureProcessor extends AudioWorkletProcessor {
              process(inputs) {
                const input = inputs[0];
                if (input && input[0]) {
                  this.port.postMessage(input[0]);
                }
                return true;
              }
            }
            registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
          `;
          const blob = new Blob([workletCode], { type: 'application/javascript' });
          const blobUrl = URL.createObjectURL(blob);
          await this.audioContext.audioWorklet.addModule(blobUrl);
          URL.revokeObjectURL(blobUrl);

          const worklet = new AudioWorkletNode(this.audioContext, 'pcm-capture-processor');
          worklet.port.onmessage = (event) => {
            handleAudioChunk(event.data);
          };
          source.connect(worklet);
          worklet.connect(this.audioContext.destination);
          this.workletNode = worklet;
          workletInitialized = true;
        } catch {
          workletInitialized = false;
        }
      }

      if (!workletInitialized) {
        // Fallback to ScriptProcessorNode
        const bufferSize = 4096;
        const script = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
        script.onaudioprocess = (event) => {
          const channelData = event.inputBuffer.getChannelData(0);
          handleAudioChunk(channelData);
        };
        source.connect(script);
        script.connect(this.audioContext.destination);
        this.scriptNode = script;
      }

      this.setState('listening');
    } catch (err) {
      this.cleanup();
      this.setState('idle');
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'idle') return;
    this.setState('stopping');

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: 'flush' }));
      } catch {
        // ignore
      }
      // Small delay to allow final recognition packet to be received
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    this.cleanup();
    this.setState('idle');
  }

  cancel(): void {
    this.cleanup();
    this.setState('idle');
  }

  private cleanup(): void {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.scriptNode) {
      try {
        this.scriptNode.disconnect();
      } catch {
        // ignore
      }
      this.scriptNode = null;
    }
    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
  }
}

export const streamingStt = new StreamingSttClient();
