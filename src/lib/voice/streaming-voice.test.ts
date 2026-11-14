import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downsampleTo16kMono, StreamingSttClient } from './streaming-stt';
import { GaplessAudioPlayer, StreamingTtsClient } from './gapless-audio';

// Mock Web Audio API
class MockAudioBuffer {
  duration: number;
  length: number;
  sampleRate: number;
  private channelData: Float32Array;

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channelData = new Float32Array(length);
  }

  getChannelData(_channel: number): Float32Array {
    return this.channelData;
  }
}

class MockAudioBufferSourceNode {
  buffer: MockAudioBuffer | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped: boolean = false;
  disconnected: boolean = false;

  start(when: number = 0) {
    this.startedAt = when;
  }

  stop() {
    this.stopped = true;
    this.onended?.();
  }

  disconnect() {
    this.disconnected = true;
  }

  connect(_dest: unknown) {}
}

class MockAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  state: 'running' | 'suspended' | 'closed' = 'running';

  createBuffer(channels: number, length: number, sampleRate: number) {
    return new MockAudioBuffer(channels, length, sampleRate);
  }

  createBufferSource() {
    return new MockAudioBufferSourceNode();
  }

  createMediaStreamSource() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  createScriptProcessor() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    };
  }

  async resume() {
    this.state = 'running';
  }

  async close() {
    this.state = 'closed';
  }

  destination = {};
}

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  binaryType = 'arraybuffer';
  sentData: (string | ArrayBuffer)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    setTimeout(() => this.onopen?.(), 5);
  }

  send(data: string | ArrayBuffer) {
    this.sentData.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe('Streaming Voice Modules', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('downsampleTo16kMono', () => {
    it('passes through 16kHz audio with proper scaling', () => {
      const input = new Float32Array([0, 0.5, -0.5, 1.0, -1.0]);
      const res = downsampleTo16kMono(input, 16000, 16000);
      expect(res.length).toBe(5);
      expect(res[0]).toBe(0);
      expect(res[1]).toBe(Math.round(0.5 * 32767));
      expect(res[2]).toBe(Math.round(-0.5 * 32768));
      expect(res[3]).toBe(32767);
      expect(res[4]).toBe(-32768);
    });

    it('downsamples from 48kHz to 16kHz (3:1 ratio)', () => {
      const input = new Float32Array(480);
      input.fill(0.2);
      const res = downsampleTo16kMono(input, 48000, 16000);
      expect(res.length).toBe(160);
      expect(res[0]).toBeCloseTo(Math.round(0.2 * 32767), -1);
    });

    it('clamps values exceeding [-1.0, 1.0]', () => {
      const input = new Float32Array([1.5, -2.0]);
      const res = downsampleTo16kMono(input, 16000, 16000);
      expect(res[0]).toBe(32767);
      expect(res[1]).toBe(-32768);
    });
  });

  describe('GaplessAudioPlayer', () => {
    it('schedules consecutive chunks with gapless timeline', () => {
      const player = new GaplessAudioPlayer({ sampleRate: 16000 });
      // 16000 samples = 1.0s at 16kHz
      const chunk1 = new Int16Array(16000);
      const chunk2 = new Int16Array(8000); // 0.5s

      player.enqueueChunk(chunk1);
      expect(player.isPlaying()).toBe(true);
      expect(player.getNextPlayTime()).toBeCloseTo(1.0, 2);

      player.enqueueChunk(chunk2);
      expect(player.getNextPlayTime()).toBeCloseTo(1.5, 2);
      expect(player.getActiveSourceCount()).toBe(2);
    });

    it('halts and stops all sources immediately on barge-in interruption', () => {
      const onInterrupted = vi.fn();
      const player = new GaplessAudioPlayer({ sampleRate: 16000, onInterrupted });

      const chunk = new Int16Array(16000);
      player.enqueueChunk(chunk);
      player.enqueueChunk(chunk);

      expect(player.getActiveSourceCount()).toBe(2);

      // Barge in
      player.interrupt();

      expect(player.isPlaying()).toBe(false);
      expect(player.getActiveSourceCount()).toBe(0);
      expect(player.getNextPlayTime()).toBe(0);
      expect(onInterrupted).toHaveBeenCalledTimes(1);

      // New chunks after interrupt are ignored until reset
      player.enqueueChunk(chunk);
      expect(player.isPlaying()).toBe(false);

      // Reset permits new playback
      player.reset();
      player.enqueueChunk(chunk);
      expect(player.isPlaying()).toBe(true);
    });
  });

  describe('StreamingTtsClient', () => {
    it('sends prompt over WebSocket, enqueues PCM chunks, and handles completion', async () => {
      const client = new StreamingTtsClient();
      const onSentenceStart = vi.fn();
      const onSentenceEnd = vi.fn();
      const onDone = vi.fn();

      const speakPromise = client.speak('Hello world! Sentence two.', {
        wsUrl: 'ws://localhost:8010/v1/voice/stream/tts',
        onSentenceStart,
        onSentenceEnd,
        onDone,
      });

      // Allow WS to open
      await new Promise((r) => setTimeout(r, 10));

      const mockWs = (client as unknown as { socket: MockWebSocket }).socket;
      expect(mockWs).toBeDefined();
      expect(mockWs.sentData.length).toBe(1);
      const initialPayload = JSON.parse(mockWs.sentData[0] as string);
      expect(initialPayload.type).toBe('prompt');
      expect(initialPayload.text).toBe('Hello world! Sentence two.');

      // Simulate server sending sentence events and binary PCM chunk
      mockWs.onmessage?.({
        data: JSON.stringify({
          type: 'sentence_start',
          sentence_index: 0,
          text: 'Hello world!',
        }),
      });
      expect(onSentenceStart).toHaveBeenCalledWith(0, 'Hello world!');

      // Send binary PCM chunk (1600 16-bit samples = 3200 bytes)
      const pcmBuffer = new Int16Array(1600).buffer;
      mockWs.onmessage?.({ data: pcmBuffer });
      expect(client.getPlayer().isPlaying()).toBe(true);

      mockWs.onmessage?.({
        data: JSON.stringify({
          type: 'sentence_end',
          sentence_index: 0,
        }),
      });
      expect(onSentenceEnd).toHaveBeenCalledWith(0);

      // Finish synthesis
      mockWs.onmessage?.({
        data: JSON.stringify({ type: 'done' }),
      });

      await speakPromise;
      expect(onDone).toHaveBeenCalled();
    });

    it('immediately sends barge_in to server and interrupts player on bargeIn()', async () => {
      const client = new StreamingTtsClient();
      const onInterrupted = vi.fn();

      const speakPromise = client.speak('Long paragraph to interrupt.', {
        wsUrl: 'ws://localhost:8010/v1/voice/stream/tts',
        onInterrupted,
      });

      await new Promise((r) => setTimeout(r, 10));

      const mockWs = (client as unknown as { socket: MockWebSocket }).socket;

      // Play audio chunk
      mockWs.onmessage?.({ data: new Int16Array(1600).buffer });
      expect(client.getPlayer().isPlaying()).toBe(true);

      // User barges in
      client.bargeIn();

      expect(client.getPlayer().isPlaying()).toBe(false);
      expect(mockWs.sentData).toContainEqual(JSON.stringify({ type: 'barge_in' }));

      // Server echoes interrupted message
      mockWs.onmessage?.({ data: JSON.stringify({ type: 'interrupted' }) });
      await speakPromise;
      expect(onInterrupted).toHaveBeenCalled();
    });
  });

  describe('StreamingSttClient', () => {
    it('handles incoming partial and final speech recognition events', async () => {
      const client = new StreamingSttClient();
      const onPartial = vi.fn();
      const onFinal = vi.fn();

      const mockStream = {
        getTracks: () => [{ stop: vi.fn() }],
      };
      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue(mockStream),
        },
      });

      await client.start({
        wsUrl: 'ws://localhost:8010/v1/voice/stream/stt',
        onPartial,
        onFinal,
      });

      expect(client.isListening()).toBe(true);

      const mockWs = (client as unknown as { socket: MockWebSocket }).socket;
      expect(mockWs).toBeDefined();

      // Simulate partial event from server
      mockWs.onmessage?.({
        data: JSON.stringify({ type: 'partial', text: 'Hello' }),
      });
      expect(onPartial).toHaveBeenCalledWith('Hello');

      // Simulate final event from server
      mockWs.onmessage?.({
        data: JSON.stringify({ type: 'final', text: 'Hello world' }),
      });
      expect(onFinal).toHaveBeenCalledWith('Hello world');

      await client.stop();
      expect(client.isListening()).toBe(false);
      expect(mockWs.sentData).toContainEqual(JSON.stringify({ type: 'flush' }));
    });
  });
});
