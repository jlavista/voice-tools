import { pipeline, env } from "./vendor/transformers/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL("./vendor/transformers/ort-wasm-simd-threaded.mjs", import.meta.url).href,
  wasm: new URL("./vendor/transformers/ort-wasm-simd-threaded.wasm", import.meta.url).href,
};
let transcriber;
self.onmessage = async ({ data }) => {
  try {
    if (!transcriber) {
      self.postMessage({ type: "status", message: "Downloading / loading the local speech model. First use may take several minutes..." });
      transcriber = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", {
        device: "wasm",
        dtype: "q8",
        revision: "5332fcc35e32a33b86612b9a57a89be7906102b1",
        progress_callback: progress => {
          if (progress.status === "progress") {
            self.postMessage({ type: "status", message: `Loading ${progress.file}: ${Math.round(progress.progress || 0)}%` });
          }
        },
      });
    }
    self.postMessage({ type: "status", message: "Transcribing on your device. Longer recordings can take several minutes..." });
    const options = { task: "transcribe", chunk_length_s: 30, stride_length_s: 5, return_timestamps: false };
    if (data.language) options.language = data.language;
    const result = await transcriber(data.samples, options);
    self.postMessage({ type: "done", text: result.text.trim() });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
