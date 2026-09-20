import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { pcm16ToFloat } from './drill-wire';

/**
 * Exercises `public/drill-capture-worklet.js` itself, by loading the shipped file into a fake
 * AudioWorkletGlobalScope. A worklet cannot import from `src/`, so the only alternative would be
 * a second copy of the resampler that drifts from the one learners actually run.
 *
 * What is worth proving: a 48 kHz browser produces the same speech as a 16 kHz one. The failure
 * this guards against is audio that exists and sounds wrong, which nobody catches by reading.
 */

const WORKLET = readFileSync(join(process.cwd(), 'public', 'drill-capture-worklet.js'), 'utf8');
const CHUNK_FRAMES = 1024;
const BLOCK = 128; // what the audio thread always hands a worklet

interface Processor {
  process(inputs: Float32Array[][]): boolean;
}

function loadProcessor(contextRate: number, chunkFrames = CHUNK_FRAMES) {
  const chunks: Int16Array[] = [];
  let ProcessorClass: new (options: unknown) => Processor;
  const sandbox = {
    sampleRate: contextRate,
    AudioWorkletProcessor: class {
      port = {
        postMessage: (buffer: ArrayBuffer) => {
          chunks.push(new Int16Array(buffer));
        },
      };
    },
    registerProcessor: (_name: string, cls: new (options: unknown) => Processor) => {
      ProcessorClass = cls;
    },
  };
  runInContext(WORKLET, createContext(sandbox));
  const processor = new ProcessorClass!({ processorOptions: { targetRate: 16_000, chunkFrames } });
  return { processor, chunks };
}

/** Feeds a signal through in 128-frame blocks, the way the audio thread does. */
function capture(signal: Float32Array, contextRate: number): Float32Array {
  const { processor, chunks } = loadProcessor(contextRate);
  for (let offset = 0; offset < signal.length; offset += BLOCK) {
    processor.process([[signal.subarray(offset, Math.min(offset + BLOCK, signal.length))]]);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(pcm16ToFloat(chunk.buffer as ArrayBuffer), at);
    at += chunk.length;
  }
  return out;
}

function sine(hz: number, seconds: number, rate: number): Float32Array {
  const samples = new Float32Array(Math.floor(seconds * rate));
  for (let i = 0; i < samples.length; i += 1) samples[i] = 0.6 * Math.sin((2 * Math.PI * hz * i) / rate);
  return samples;
}

/** Cheap pitch estimate: zero crossings per second, halved (a full cycle crosses twice). */
function estimateHz(samples: Float32Array, rate: number): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i - 1] < 0 && samples[i] >= 0) crossings += 1;
  }
  return (crossings * rate) / samples.length;
}

describe('drill capture worklet', () => {
  it('passes a 16 kHz context through unchanged', () => {
    const input = sine(440, 0.5, 16_000);
    const output = capture(input, 16_000);
    expect(output.length).toBeGreaterThan(0);
    for (let i = 0; i < output.length; i += 1) {
      expect(output[i]).toBeCloseTo(input[i], 3);
    }
  });

  it('resamples a 48 kHz context down to 16 kHz', () => {
    const output = capture(sine(440, 1, 48_000), 48_000);
    // One second in, one second out, rounded down to whole chunks.
    expect(output.length).toBeGreaterThan(16_000 - CHUNK_FRAMES);
    expect(output.length).toBeLessThanOrEqual(16_000);
    expect(estimateHz(output, 16_000)).toBeGreaterThan(430);
    expect(estimateHz(output, 16_000)).toBeLessThan(450);
  });

  it('resamples a 44.1 kHz context, where the ratio is not a whole number', () => {
    const output = capture(sine(300, 1, 44_100), 44_100);
    expect(estimateHz(output, 16_000)).toBeGreaterThan(292);
    expect(estimateHz(output, 16_000)).toBeLessThan(308);
  });

  it('keeps the signal continuous across block boundaries', () => {
    // A click at every 128 frame boundary is exactly what a reset read position sounds like.
    const output = capture(sine(200, 0.5, 48_000), 48_000);
    let biggestJump = 0;
    for (let i = 1; i < output.length; i += 1) {
      biggestJump = Math.max(biggestJump, Math.abs(output[i] - output[i - 1]));
    }
    // A 200 Hz sine at 16 kHz moves at most about 0.047 per sample at this amplitude.
    expect(biggestJump).toBeLessThan(0.1);
  });

  it('emits whole chunks of the size the socket expects', () => {
    const { processor, chunks } = loadProcessor(48_000);
    const input = sine(440, 0.5, 48_000);
    for (let offset = 0; offset < input.length; offset += BLOCK) {
      processor.process([[input.subarray(offset, offset + BLOCK)]]);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.length === CHUNK_FRAMES)).toBe(true);
  });

  it('survives a block with no input', () => {
    const { processor, chunks } = loadProcessor(16_000);
    expect(processor.process([[]])).toBe(true);
    expect(processor.process([])).toBe(true);
    expect(chunks).toHaveLength(0);
  });

  it('clamps rather than wrapping when the microphone is loud', () => {
    const loud = new Float32Array(CHUNK_FRAMES * 4).fill(2);
    const output = capture(loud, 16_000);
    // Wrapping would flip the sign and turn a loud voice into a burst of noise.
    expect(output.every((sample) => sample > 0.99)).toBe(true);
  });
});
