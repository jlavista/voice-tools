# JustTools / Voice Tools

Record, edit, export, and transcribe audio in the browser. Static HTML, CSS, JavaScript, and local WebAssembly; no backend, accounts, or audio uploads.

- Website: https://jlavista.github.io/voice-tools/
- JustTools directory: https://jlavista.github.io/just-tools/

## Features

- Record a microphone with explicit permission, stop, or cancel; microphone tracks are released afterwards.
- Import multiple MP3, WAV, M4A/AAC, Ogg/Opus, WebM, FLAC, and other files supported by the browser's audio decoder.
- Waveform range selection and precise time fields; preview a selection.
- Reorder clips, join checked clips sequentially, split at a chosen point, keep or cut a range, duplicate, and remove.
- Normalize, adjust gain without clipping, reverse, fade in/out, and silence a selected range.
- Undo/redo the last five changes. Operations are non-destructive to imported files.
- Export the current clip or range as 16-bit PCM WAV or 192 kbps MP3.
- Export WebM/Opus, Ogg/Opus, or M4A/AAC **only when the browser reports encoder support**. These exports run in real time without speaker playback. Keep the tab open.
- Voice-to-text with Whisper base.en for English (the default), and multilingual Whisper tiny for other languages or automatic detection, editable output, copy, and UTF-8 text download.
- Cancel lengthy encoding, model loading, or speech recognition. Remove this tool's cached speech-model files.

## Privacy and downloads

All decoding, editing, encoding, recording, and speech inference happen on the device. Audio and transcript contents are not sent to any server, stored automatically, or added to analytics. Reloading clears the workspace.

After the user checks the download permission and presses Extract text, Transformers.js retrieves the selected quantized model from Hugging Face: `Xenova/whisper-base.en` for explicitly selected English (roughly 77 MB of weights), or `Xenova/whisper-tiny` for other languages and automatic detection (roughly 41 MB). Both need additional small configuration/tokenizer files. Revisions are pinned in `speech-worker.js`. English is selected by default; choose English to use base.en even when automatic detection would recognize English. Changing model releases the previous model's inference sessions rather than keeping both in memory. Cache cleanup removes both models, leaving unrelated entries alone.

Model requests can redirect to Hugging Face's CDN. These hosts receive normal HTTP request metadata, not audio. Models are cached with the browser Cache API when available; browsers may evict them. Network access is needed if files are not cached.

JavaScript audio encoders, Transformers.js, and the ONNX CPU WebAssembly runtime are vendored and served with the site. No remote speech service or browser `SpeechRecognition` API is used.

The published page includes the same cookie-free Cloudflare Web Analytics beacon as the other JustTools websites. It reports ordinary page-traffic/performance metadata, not clip names, audio, or transcript contents. Editing and transcription also work when analytics is blocked.

## Local development

From the project directory:

```powershell
python -m http.server 8002 --bind 127.0.0.1
```

Open http://localhost:8002/. HTTPS or localhost is required for microphone and clipboard permissions. Opening `index.html` with `file://` will not work.

No build step or package installation is needed to host the app. Publish the repository root with GitHub Pages.

## Limits and compatibility

Use a current Edge, Chrome, Firefox, or Safari with Web Audio, workers, and WebAssembly. Input format and optional output format support vary by browser. Microphone recording also requires MediaRecorder; clipboard copy requires permission. WAV/MP3 export does not require MediaRecorder.

Audio is downmixed to stereo and resampled to 44.1 kHz before editing. Speech recognition uses a separate 16 kHz mono copy. Metadata, artwork, original compressed encoding, and channel layouts are not preserved. Re-encoding MP3 is lossy; WAV avoids further codec compression.

The workspace is limited to ten minutes of decoded audio, with a 100 MB limit per imported file. Decoded audio, undo history, and speech models consume substantially more memory than compressed input. Low-memory phones may struggle; use short recordings and keep originals. Effects apply to the selected range, while joins concatenate (not mix) clips. Undo does not restore text.

Whisper base.en improves English recognition over the multilingual tiny model, at the cost of a larger download and slower processing. Other languages still use tiny, which trades accuracy for a smaller browser download. Language quality varies; noise, overlapping speakers, music, and silence can cause incorrect or invented words. Results are not reliable for high-stakes decisions. Transcription is slower on older devices. Cancellation stops the speech worker, but previously downloaded model files may remain cached.

## Tests

The browser regression suite uses Python's `unittest`, Playwright, and `imageio-ffmpeg` for independent audio decoding. These are test-only tools, not website dependencies.

```powershell
python -m pip install playwright imageio-ffmpeg
python -m unittest discover -s tests -v
```

The suite uses the installed Microsoft Edge on Windows. Set `VOICE_TEST_BROWSER` to another Chromium executable if needed. It uses fake microphone input and mocks clipboard calls, never the user's real microphone or clipboard. Set `VOICE_TEST_SPEECH` to a synthetic English spoken WAV fixture to additionally run real model-download/inference verification. Also set `VOICE_TEST_SPANISH` to a synthetic Spanish fixture to verify switching between English and multilingual models.

## Open source

Application code is MIT licensed. Unmodified vendored libraries retain their own licenses:

| Component | Version | License / source |
|---|---|---|
| lamejs (LAME-based MP3 encoder) | 1.2.1 | LGPL-3.0; https://github.com/zhuker/lamejs and https://lame.sourceforge.net/ |
| Transformers.js | 3.8.1 | Apache-2.0; https://github.com/huggingface/transformers.js |
| ONNX Runtime Web | 1.22.0-dev.20250409-89f8206ba4 | MIT; https://github.com/microsoft/onnxruntime |
| Whisper base.en and tiny models, downloaded on demand | pinned ONNX revisions | Apache-2.0; https://huggingface.co/Xenova/whisper-base.en and https://huggingface.co/Xenova/whisper-tiny |

License notices are included under `vendor`. The MP3 encoder remains a separate, unmodified script; its matching [upstream release source archive](vendor/lame/source.tgz) is bundled alongside it. The archive's encoder was verified byte-for-byte against the distributed script. Source is also available from [the exact npm release](https://www.npmjs.com/package/lamejs/v/1.2.1) and [upstream](https://github.com/zhuker/lamejs/tree/1.2.1).
