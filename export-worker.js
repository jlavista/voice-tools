self.onmessage = async ({ data }) => {
  try {
    const { channels, format, sampleRate } = data;
    if (format === "wav") {
      const { encodeWav } = await import("./audio-utils.js");
      const buffer = encodeWav(channels, sampleRate);
      self.postMessage({ type: "done", buffer, mime: "audio/wav" }, [buffer]);
      return;
    }
    importScripts("./vendor/lame/lame.min.js");
    const encoder = new lamejs.Mp3Encoder(2, sampleRate, 192);
    const blocks = [];
    let size = 0;
    const pcm = samples => Int16Array.from(samples, value => {
      const sample = Math.max(-1, Math.min(1, value));
      return Math.round(sample * (sample < 0 ? 32768 : 32767));
    });
    for (let i = 0; i < channels[0].length; i += 1152) {
      const block = encoder.encodeBuffer(pcm(channels[0].subarray(i, i + 1152)), pcm(channels[1].subarray(i, i + 1152)));
      if (block.length) { blocks.push(block); size += block.length; }
      if (i % (1152 * 40) === 0) self.postMessage({ type: "progress", value: i / channels[0].length * 100 });
    }
    const tail = encoder.flush();
    blocks.push(tail); size += tail.length;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const block of blocks) { bytes.set(block, offset); offset += block.length; }
    self.postMessage({ type: "done", buffer: bytes.buffer, mime: "audio/mpeg" }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
