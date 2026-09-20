/**
 * Microphone capture for a drill.
 *
 * Runs on the audio thread and hands the main thread finished 16 kHz, 16-bit, mono PCM chunks,
 * ready to put straight on the socket. Doing the conversion here rather than in React keeps the
 * main thread free during a call and halves what crosses the thread boundary.
 *
 * We ask for a 16 kHz AudioContext, which is usually granted and makes the resampling below a
 * no-op (`step` is 1). When a browser insists on its own rate (48 kHz is common) this resamples
 * rather than sending audio at the wrong rate: that failure mode is audio that exists and sounds
 * wrong, which is the slowest kind of bug to notice.
 *
 * `sampleRate` is a global inside an AudioWorkletGlobalScope: the context's real rate.
 */

class DrillCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    const { targetRate = 16000, chunkFrames = 1024 } = (options && options.processorOptions) || {};
    super();
    this.step = sampleRate / targetRate;
    this.chunk = new Int16Array(chunkFrames);
    this.filled = 0;
    // Read position inside the current block, carried across blocks so there is no click every
    // 128 frames. It can be slightly negative, meaning "between the last sample of the previous
    // block and the first of this one", which is why the previous sample is kept.
    this.position = 0;
    this.previous = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    const last = channel.length - 1;
    const valueAt = (index) => (index < 0 ? this.previous : channel[index]);

    let position = this.position;
    // Stop one sample short of the end so the right neighbour always exists; whatever is left
    // over is carried into the next block rather than guessed at.
    while (position <= last) {
      const index = Math.floor(position);
      const fraction = position - index;
      // When the read lands exactly on a sample there is no right neighbour to reach for, and
      // reaching anyway walks off the end of the block: `undefined * 0` is NaN, which becomes a
      // zeroed sample, which at a 16 kHz context is every 128th sample and an audible buzz.
      const sample =
        fraction === 0
          ? valueAt(index)
          : valueAt(index) * (1 - fraction) + valueAt(Math.min(index + 1, last)) * fraction;

      const clamped = Math.max(-1, Math.min(1, sample));
      // Asymmetric on purpose: 32767 and -32768 are the real ends of the range.
      this.chunk[this.filled] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.filled += 1;
      if (this.filled === this.chunk.length) {
        const copy = this.chunk.slice();
        this.port.postMessage(copy.buffer, [copy.buffer]);
        this.filled = 0;
      }
      position += this.step;
    }

    this.position = position - channel.length;
    this.previous = channel[last];
    return true;
  }
}

registerProcessor('drill-capture', DrillCaptureProcessor);
