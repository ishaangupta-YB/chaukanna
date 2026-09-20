/**
 * The browser half of the drill wire protocol. The mirror of this file is
 * `apps/agent/chaukanna_agent/wire.py`, which has the full description. Change them together.
 *
 * Audio is raw PCM in binary frames: 16-bit signed little-endian, mono, 16 kHz, in both
 * directions. Everything else is one JSON object per text frame.
 */

/** 16 kHz mono 16-bit, the rate Nova Sonic speaks and hears. Matches `audio.py`. */
export const SAMPLE_RATE = 16_000;
/** 1024 frames, 64 ms. Small enough for low latency, far under AgentCore's 64 KB frame cap. */
export const CHUNK_FRAMES = 1024;

export interface ReadyMessage {
  type: 'ready';
  v: number;
  drillId: string;
  maxSeconds: number;
  safeWord: string;
  language: 'hi-IN' | 'en-IN';
}

export interface CaptionMessage {
  type: 'caption';
  role: 'caller' | 'learner';
  text: string;
}

export interface ClearMessage {
  type: 'clear';
}

export interface EndedMessage {
  type: 'ended';
  reason: string | null;
  finalStage: string;
  durationSeconds: number;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
}

export type ServerMessage = ReadyMessage | CaptionMessage | ClearMessage | EndedMessage | ErrorMessage;

export function helloFrame(token: string): string {
  return JSON.stringify({ type: 'hello', token });
}

export function hangupFrame(): string {
  return JSON.stringify({ type: 'hangup' });
}

/**
 * Parses a text frame. Returns null rather than throwing for anything unrecognised, so a newer
 * agent adding a message type cannot break an older page mid call.
 */
export function parseServerMessage(data: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const type = (parsed as { type?: unknown }).type;
  if (type === 'ready' || type === 'caption' || type === 'clear' || type === 'ended' || type === 'error') {
    return parsed as ServerMessage;
  }
  return null;
}

/** Float samples in [-1, 1] to the 16-bit little-endian PCM the model expects. */
export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    // Asymmetric on purpose: 32767 and -32768 are the real ends of the range.
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buffer;
}

/**
 * The other direction, for playing the caller's voice through an AudioBuffer.
 *
 * The buffer type is spelled out because `AudioBuffer.copyToChannel` will not accept a view that
 * might be backed by a SharedArrayBuffer.
 */
export function pcm16ToFloat(buffer: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(buffer);
  const samples = new Float32Array(buffer.byteLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return samples;
}
