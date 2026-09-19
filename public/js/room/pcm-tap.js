// AudioWorklet: hands the microphone's raw samples to the page in ~40 ms
// chunks, for server-side transcription (see voice.js).
/* global AudioWorkletProcessor, registerProcessor */

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(2048);
    this.fill = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      let offset = 0;
      while (offset < channel.length) {
        const count = Math.min(channel.length - offset, this.chunk.length - this.fill);
        this.chunk.set(channel.subarray(offset, offset + count), this.fill);
        this.fill += count;
        offset += count;
        if (this.fill === this.chunk.length) {
          this.port.postMessage(this.chunk, [this.chunk.buffer]);
          this.chunk = new Float32Array(2048);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
