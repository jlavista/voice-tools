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
let loadedModel;
self.onmessage = async ({ data }) => {
  try {
    const english = data.language === "english";
    const model = english ? "Xenova/whisper-base.en" : "Xenova/whisper-tiny";
    if (!transcriber || loadedModel !== model) {
      if (transcriber) {
        await transcriber.dispose();
        transcriber = null;
        loadedModel = null;
      }
      self.postMessage({ type: "status", message: `Downloading / loading ${english ? "English Whisper base.en" : "multilingual Whisper tiny"}. First use may take several minutes...` });
      transcriber = await pipeline("automatic-speech-recognition", model, {
        device: "wasm",
        dtype: "q8",
        revision: english ? "95bf40a508535962c6483ead40270b2e32267508" : "5332fcc35e32a33b86612b9a57a89be7906102b1",
        progress_callback: progress => {
          if (progress.status === "progress") {
            self.postMessage({ type: "status", message: `Loading ${progress.file}: ${Math.round(progress.progress || 0)}%` });
          }
        },
      });
      loadedModel = model;
    }
    self.postMessage({ type: "status", message: "Transcribing on your device. Longer recordings can take several minutes..." });
    const options = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false };
    if (!english) {
      options.task = "transcribe";
      if (data.language) options.language = data.language;
    }
    const result = await transcriber(data.samples, options);
    self.postMessage({ type: "done", text: result.text.trim() });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
