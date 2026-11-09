export const SAMPLE_RATE = 44100;
export const MAX_FRAMES = SAMPLE_RATE * 600;

export function frameRange(start, end, length, sampleRate = SAMPLE_RATE) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start ||
      end > length / sampleRate + 0.0005) {
    throw new Error("Enter a valid start and end within the clip, with end after start.");
  }
  const first = Math.min(length, Math.round(start * sampleRate));
  const last = Math.min(length, Math.round(end * sampleRate));
  if (last <= first) throw new Error("Select a non-empty audio range.");
  return [first, last];
}

export function sliceAudio(channels, first, last) {
  return channels.map(channel => channel.slice(first, last));
}

export function joinAudio(clips) {
  const length = clips.reduce((total, channels) => total + channels[0].length, 0);
  if (!length || length > MAX_FRAMES) throw new Error("Joined audio must be between zero and 10 minutes.");
  const result = [new Float32Array(length), new Float32Array(length)];
  let offset = 0;
  for (const channels of clips) {
    result[0].set(channels[0], offset);
    result[1].set(channels[1] || channels[0], offset);
    offset += channels[0].length;
  }
  return result;
}

export function cutAudio(channels, first, last) {
  if (first === 0 && last === channels[0].length) {
    throw new Error("Cut would remove the entire clip. Remove the clip instead, or select a smaller range.");
  }
  return channels.map(channel => {
    const result = new Float32Array(channel.length - (last - first));
    result.set(channel.subarray(0, first));
    result.set(channel.subarray(last), first);
    return result;
  });
}

export function applyEffect(channels, first, last, effect, gainDb = 0) {
  let scale = 1;
  if (effect === "normalize" || effect === "gain") {
    let peak = 0;
    for (const channel of channels) {
      for (let i = first; i < last; i++) peak = Math.max(peak, Math.abs(channel[i]));
    }
    if (effect === "normalize") {
      if (!peak) throw new Error("The selected range is silent; there is nothing to normalize.");
      scale = 0.95 / peak;
    } else {
      if (!Number.isFinite(gainDb) || gainDb < -40 || gainDb > 20) throw new Error("Volume must be between -40 and +20 dB.");
      scale = Math.min(10 ** (gainDb / 20), peak ? 1 / peak : Infinity);
    }
  }
  return channels.map(channel => {
    const result = channel.slice();
    for (let i = first; i < last; i++) {
      const fraction = (i - first) / Math.max(1, last - first - 1);
      switch (effect) {
        case "normalize":
        case "gain": result[i] *= scale; break;
        case "reverse": result[i] = channel[last - 1 - (i - first)]; break;
        case "fade-in": result[i] *= fraction; break;
        case "fade-out": result[i] *= 1 - fraction; break;
        case "silence": result[i] = 0; break;
        default: throw new Error("Unknown audio effect.");
      }
    }
    return result;
  });
}

export function encodeWav(channels, sampleRate = SAMPLE_RATE) {
  const count = channels.length;
  const length = channels[0].length;
  const bytes = length * count * 2;
  const result = new ArrayBuffer(44 + bytes);
  const view = new DataView(result);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF"); view.setUint32(4, 36 + bytes, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, count, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true);
  view.setUint16(32, count * 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, bytes, true);
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
  }
  return result;
}
