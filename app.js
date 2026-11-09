import { SAMPLE_RATE, MAX_FRAMES, frameRange, sliceAudio, joinAudio, cutAudio, applyEffect } from "./audio-utils.js";

const $ = id => document.getElementById(id);
const state = { clips: [], active: null, undo: [], redo: [], task: null };
let audioContext;
let playback;
let playbackFrame;
let recorder;
let speechWorker;
let serial = 0;
let dragStart = null;
const peaksCache = new WeakMap();
const nativeFormats = [
  { value: "webm", mime: "audio/webm;codecs=opus", label: "WebM / Opus (real-time export)" },
  { value: "ogg", mime: "audio/ogg;codecs=opus", label: "Ogg / Opus (real-time export)" },
  { value: "m4a", mime: "audio/mp4;codecs=mp4a.40.2", label: "M4A / AAC (real-time export)" },
];
const activeClip = () => state.clips.find(clip => clip.id === state.active);
const totalFrames = clips => clips.reduce((total, clip) => total + clip.channels[0].length, 0);
const seconds = channels => channels[0].length / SAMPLE_RATE;
const time = value => `${Math.floor(value / 60)}:${(value % 60).toFixed(2).padStart(5, "0")}`;

function status(message) { $("status").textContent = message; }
function fail(error) {
  $("error").hidden = false;
  $("error").textContent = error.message || String(error);
  status("Task could not be completed. Your existing clips have been kept.");
}
function clearError() { $("error").hidden = true; $("error").textContent = ""; }
function clearText() { $("text").value = ""; $("text-source").textContent = "Text is not saved anywhere automatically."; }
function makeClip(name, channels) { return { id: ++serial, name, channels, checked: true }; }

function remember() {
  state.undo.push({ clips: state.clips, active: state.active });
  if (state.undo.length > 5) state.undo.shift();
  state.redo = [];
}

function commit(clips, active, message) {
  if (totalFrames(clips) > MAX_FRAMES) throw new Error("The workspace limit is 10 minutes. Remove clips before adding more.");
  stopPlayback();
  remember();
  state.clips = clips;
  state.active = active;
  clearText();
  render(true);
  clearError();
  status(message);
}

function selection() {
  const clip = activeClip();
  if (!clip) throw new Error("Choose an audio clip first.");
  return frameRange($("start").valueAsNumber, $("end").valueAsNumber, clip.channels[0].length);
}

function scopeChannels(scope) {
  const clip = activeClip();
  if (!clip) throw new Error("Choose an audio clip first.");
  if (scope === "selection") {
    const [first, last] = selection();
    return sliceAudio(clip.channels, first, last);
  }
  return clip.channels;
}

function updateControls() {
  const busy = Boolean(state.task);
  const hasClip = Boolean(activeClip());
  document.querySelectorAll("[data-lock]").forEach(element => { element.disabled = busy; });
  $("clear").disabled = busy || !state.clips.length;
  $("join").disabled = busy || state.clips.filter(clip => clip.checked).length < 2;
  $("download").disabled = busy || !hasClip;
  $("transcribe").disabled = busy || !hasClip || !$("model-consent").checked;
  $("record").disabled = busy || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
  $("stop-record").disabled = !recorder || recorder.state === "inactive";
  $("cancel").disabled = !busy;
  $("undo").disabled = busy || !state.undo.length;
  $("redo").disabled = busy || !state.redo.length;
  $("copy-text").disabled = busy || !$("text").value.trim();
  $("save-text").disabled = busy || !$("text").value.trim();
  $("stop-play").disabled = !playback;
  $("clips").querySelectorAll("button,input").forEach(element => {
    element.disabled = busy || element.dataset.boundary === "true";
  });
}

function render(resetRange = false) {
  const clip = activeClip();
  $("clips").replaceChildren();
  state.clips.forEach((item, index) => {
    const row = document.createElement("li");
    row.className = `clip${item.id === state.active ? " active" : ""}`;
    const heading = document.createElement("div");
    heading.className = "clip-heading";
    const check = document.createElement("input");
    check.type = "checkbox"; check.checked = item.checked;
    check.setAttribute("aria-label", `Include ${item.name} when joining`);
    check.addEventListener("change", () => {
      state.clips = state.clips.map(entry => entry.id === item.id ? { ...entry, checked: check.checked } : entry);
      updateControls();
    });
    const name = document.createElement("button");
    name.type = "button"; name.className = "clip-name"; name.textContent = item.name;
    name.setAttribute("aria-pressed", String(item.id === state.active));
    name.addEventListener("click", () => {
      stopPlayback(); state.active = item.id; clearText(); clearError(); render(true);
    });
    heading.append(check, name);
    const detail = document.createElement("p");
    detail.className = "hint"; detail.textContent = `${time(seconds(item.channels))} / stereo`;
    const actions = document.createElement("div");
    actions.className = "clip-actions";
    for (const [label, symbol, direction] of [["Move up", "\u2191", -1], ["Move down", "\u2193", 1], ["Remove", "\u00d7", 0]]) {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = symbol; button.setAttribute("aria-label", `${label}: ${item.name}`);
      button.dataset.boundary = String(direction !== 0 && (index + direction < 0 || index + direction >= state.clips.length));
      button.addEventListener("click", () => attempt(() => {
        const clips = [...state.clips];
        if (direction) [clips[index], clips[index + direction]] = [clips[index + direction], clips[index]];
        else clips.splice(index, 1);
        const next = clips.some(entry => entry.id === state.active) ? state.active : clips[0]?.id ?? null;
        commit(clips, next, direction ? "Clip order updated." : "Clip removed. Undo restores it.");
      }));
      actions.append(button);
    }
    row.append(heading, detail, actions); $("clips").append(row);
  });
  $("empty").hidden = Boolean(clip);
  $("edit-area").hidden = !clip;
  $("duration").textContent = clip ? `${time(seconds(clip.channels))} / 44.1 kHz` : "NO CLIP SELECTED";
  $("summary").textContent = `${state.clips.length} clips / ${time(totalFrames(state.clips) / SAMPLE_RATE)} total`;
  if (clip) {
    $("clip-name").value = clip.name;
    if (resetRange) { $("start").value = "0"; $("end").value = seconds(clip.channels).toFixed(6); }
    $("start").max = $("end").max = seconds(clip.channels).toFixed(6);
    drawWaveform();
  }
  updateControls();
}

function attempt(action) {
  if (state.task) return;
  try { clearError(); action(); } catch (error) { fail(error); }
}

async function runTask(message, action) {
  if (state.task) return;
  const task = { cancelled: false, cancel: null };
  state.task = task;
  stopPlayback(); clearError(); status(message);
  $("progress").hidden = false; $("progress").removeAttribute("value");
  updateControls();
  try {
    await action(task);
  } catch (error) {
    if (!task.cancelled) fail(error);
  } finally {
    if (task.cancelled) status("Task cancelled. Existing clips are unchanged.");
    state.task = null;
    $("progress").hidden = true;
    updateControls();
  }
}

function getContext() {
  audioContext ??= new AudioContext({ sampleRate: SAMPLE_RATE });
  return audioContext;
}

function toBuffer(channels, sampleRate = SAMPLE_RATE, context = getContext()) {
  const buffer = context.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
  return buffer;
}

async function resample(buffer, sampleRate, channelCount) {
  const length = Math.round(buffer.duration * sampleRate);
  const context = new OfflineAudioContext(channelCount, length, sampleRate);
  const source = context.createBufferSource();
  source.buffer = buffer; source.connect(context.destination); source.start();
  const rendered = await context.startRendering();
  return Array.from({ length: channelCount }, (_, index) => rendered.getChannelData(index).slice());
}

async function decodeFile(file) {
  if (!file.size) throw new Error(`${file.name}: the file is empty.`);
  if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name}: files must be no larger than 100 MB.`);
  const data = await file.arrayBuffer();
  let buffer;
  try {
    const decoder = new OfflineAudioContext(2, 1, SAMPLE_RATE);
    buffer = await decoder.decodeAudioData(data);
  } catch {
    throw new Error(`${file.name}: this browser cannot decode the file, or it is damaged. Try WAV or MP3.`);
  }
  if (!buffer.length || !Number.isFinite(buffer.duration) || buffer.duration > 600) {
    throw new Error(`${file.name}: audio must be non-empty and no longer than 10 minutes.`);
  }
  return resample(buffer, SAMPLE_RATE, 2);
}

async function addFiles(files) {
  const input = [...files];
  if (!input.length) return;
  await runTask("Decoding audio locally...", async task => {
    const additions = [];
    for (const file of input) {
      if (task.cancelled) return;
      status(`Decoding ${file.name} on your device...`);
      const channels = await decodeFile(file);
      additions.push(makeClip(file.name.replace(/\.[^.]+$/, ""), channels));
      if (totalFrames([...state.clips, ...additions]) > MAX_FRAMES) throw new Error("These files exceed the 10-minute workspace limit. Add fewer files.");
    }
    if (!task.cancelled) commit([...state.clips, ...additions], additions[0].id, `${additions.length} audio files added. Nothing was uploaded.`);
  });
}

function drawWaveform(playPosition) {
  const clip = activeClip();
  if (!clip) return;
  const canvas = $("waveform");
  const width = Math.max(1, Math.round(canvas.clientWidth));
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(180 * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  let peaks = peaksCache.get(clip.channels);
  if (!peaks) {
    peaks = new Float32Array(1000);
    const length = clip.channels[0].length;
    for (let i = 0; i < peaks.length; i++) {
      const first = Math.floor(i * length / peaks.length);
      const last = Math.max(first + 1, Math.floor((i + 1) * length / peaks.length));
      for (let j = first; j < Math.min(last, length); j++) {
        peaks[i] = Math.max(peaks[i], Math.abs(clip.channels[0][j]), Math.abs(clip.channels[1][j]));
      }
    }
    peaksCache.set(clip.channels, peaks);
  }
  const duration = seconds(clip.channels);
  const start = Math.max(0, Math.min(duration, Number($("start").value) || 0)) / duration * width;
  const end = Math.max(0, Math.min(duration, Number($("end").value) || 0)) / duration * width;
  context.fillStyle = "#d9eadd"; context.fillRect(start, 0, Math.max(1, end - start), 180);
  context.strokeStyle = "#43826b"; context.beginPath();
  for (let x = 0; x < width; x++) {
    const peak = peaks[Math.min(999, Math.floor(x / width * 1000))] * 76;
    context.moveTo(x, 90 - Math.max(1, peak)); context.lineTo(x, 90 + Math.max(1, peak));
  }
  context.stroke();
  context.strokeStyle = "#284d3f"; context.beginPath();
  context.moveTo(start, 0); context.lineTo(start, 180); context.moveTo(end, 0); context.lineTo(end, 180); context.stroke();
  if (playPosition !== undefined) {
    const x = playPosition / duration * width;
    context.strokeStyle = "#ac6632"; context.beginPath(); context.moveTo(x, 0); context.lineTo(x, 180); context.stroke();
  }
}

function stopPlayback() {
  if (playback) { playback.source.onended = null; playback.source.stop(); playback.source.disconnect(); playback = null; }
  cancelAnimationFrame(playbackFrame);
  $("play-time").textContent = "";
  $("stop-play").disabled = true;
  if (activeClip()) drawWaveform();
}

async function playSelection() {
  if (state.task) return;
  try {
    const [first, last] = selection();
    const clip = activeClip();
    stopPlayback(); clearError();
    const context = getContext();
    await context.resume();
    if (state.task || activeClip() !== clip) return;
    stopPlayback();
    const source = context.createBufferSource();
    source.buffer = toBuffer(clip.channels);
    source.connect(context.destination);
    const start = first / SAMPLE_RATE;
    const duration = (last - first) / SAMPLE_RATE;
    playback = { source, clock: context.currentTime, start, duration };
    source.onended = stopPlayback;
    source.start(0, start, duration);
    updateControls();
    const tick = () => {
      if (!playback) return;
      const position = playback.start + Math.min(playback.duration, context.currentTime - playback.clock);
      $("play-time").textContent = time(position); drawWaveform(position);
      playbackFrame = requestAnimationFrame(tick);
    };
    tick();
  } catch (error) { fail(error); }
}

function edit(effect) {
  const clip = activeClip();
  const [first, last] = selection();
  let channels;
  if (effect === "trim") channels = sliceAudio(clip.channels, first, last);
  else if (effect === "cut") channels = cutAudio(clip.channels, first, last);
  else channels = applyEffect(clip.channels, first, last, effect, $("gain").valueAsNumber);
  commit(state.clips.map(item => item.id === clip.id ? { ...clip, channels } : item), clip.id, "Audio updated. Undo is available for the last five changes.");
}

function splitClip() {
  const clip = activeClip();
  const point = Math.round($("start").valueAsNumber * SAMPLE_RATE);
  if (!Number.isFinite(point) || point <= 0 || point >= clip.channels[0].length) {
    throw new Error("Set the start / split point somewhere inside the clip, not at either end.");
  }
  const left = makeClip(`${clip.name} - part 1`, sliceAudio(clip.channels, 0, point));
  const right = makeClip(`${clip.name} - part 2`, sliceAudio(clip.channels, point, clip.channels[0].length));
  const index = state.clips.indexOf(clip);
  const clips = [...state.clips]; clips.splice(index, 1, left, right);
  commit(clips, left.id, "Clip split into two parts. Check both to join them again.");
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function filename(extension) {
  return `${(activeClip()?.name || "my-audio").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim().slice(0, 100) || "my-audio"}.${extension}`;
}

function workerJob(worker, data, task) {
  return new Promise((resolve, reject) => {
    const cancel = () => { worker.terminate(); reject(new DOMException("Task cancelled", "AbortError")); };
    task.cancel = cancel;
    worker.onerror = event => {
      event.preventDefault(); reject(new Error(event.message || "The local worker could not load. Reload and try again."));
    };
    worker.onmessageerror = () => reject(new Error("The local worker returned an unreadable result."));
    worker.onmessage = ({ data: result }) => {
      if (result.type === "done") { task.cancel = null; resolve(result); }
      else if (result.type === "error") reject(new Error(result.message));
      else if (result.type === "progress") $("progress").value = result.value;
      else if (result.type === "status") status(result.message);
    };
    worker.postMessage(data);
  });
}

async function exportNative(channels, format, task) {
  const context = getContext();
  await context.resume();
  if (task.cancelled) return null;
  const destination = context.createMediaStreamDestination();
  const source = context.createBufferSource();
  source.buffer = toBuffer(channels);
  source.connect(destination);
  const media = new MediaRecorder(destination.stream, { mimeType: format.mime, audioBitsPerSecond: 192000 });
  const parts = [];
  let startedAt;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const stop = () => { if (media.state !== "inactive") media.stop(); };
      task.cancel = () => { source.onended = null; source.stop(); stop(); reject(new DOMException("Task cancelled", "AbortError")); };
      media.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      media.onerror = event => reject(new Error(event.error?.message || "Browser audio encoding failed."));
      media.onstop = () => {
        const blob = new Blob(parts, { type: media.mimeType });
        if (!blob.size) reject(new Error("Browser produced an empty audio file."));
        else resolve(blob);
      };
      source.onended = () => { setTimeout(stop, 200); };
      media.start(250); startedAt = context.currentTime; source.start();
      timer = setInterval(() => {
        $("progress").value = Math.min(99, (context.currentTime - startedAt) / source.buffer.duration * 100);
      }, 200);
    });
  } finally {
    clearInterval(timer); source.onended = null;
    source.stop(); source.disconnect();
    if (media.state !== "inactive") media.stop();
    destination.stream.getTracks().forEach(track => track.stop());
    task.cancel = null;
  }
}

async function exportAudio() {
  await runTask("Encoding audio on your device...", async task => {
    const channels = scopeChannels($("export-scope").value);
    const format = $("format").value;
    let blob;
    if (format === "wav" || format === "mp3") {
      const worker = new Worker("./export-worker.js");
      try {
        const result = await workerJob(worker, { channels, format, sampleRate: SAMPLE_RATE }, task);
        blob = new Blob([result.buffer], { type: result.mime });
      } finally { worker.terminate(); task.cancel = null; }
    } else {
      const selected = nativeFormats.find(item => item.value === format);
      if (!selected || !MediaRecorder.isTypeSupported(selected.mime)) throw new Error("This export format is not supported by your browser.");
      status("Encoding in real time, without playing to your speakers. Keep this tab open...");
      blob = await exportNative(channels, selected, task);
    }
    if (!task.cancelled && blob) { downloadBlob(blob, filename(format)); status("Audio file created. Check your browser downloads."); }
  });
}

async function recordAudio() {
  await runTask("Requesting microphone permission...", async task => {
    let stream;
    let timer;
    const remaining = (MAX_FRAMES - totalFrames(state.clips)) / SAMPLE_RATE;
    if (remaining < 1) throw new Error("Remove some clips first; the workspace has reached its 10-minute limit.");
    try {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (error) { throw new Error(`Microphone could not be opened (${error.name}). Allow access in your browser, or import an audio file.`); }
      if (task.cancelled) return;
      const mime = nativeFormats.find(item => MediaRecorder.isTypeSupported(item.mime))?.mime;
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const media = recorder;
      const parts = [];
      let cancelled = false;
      const started = performance.now();
      const blob = await new Promise((resolve, reject) => {
        task.cancel = () => {
          cancelled = true;
          if (recorder.state !== "inactive") recorder.stop();
          reject(new DOMException("Recording cancelled", "AbortError"));
        };
        recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
        recorder.onerror = event => reject(new Error(event.error?.message || "Recording failed."));
        recorder.onstop = () => resolve(new Blob(parts, { type: media.mimeType }));
        stream.getAudioTracks().forEach(track => {
          track.onended = () => {
            if (recorder && recorder.state !== "inactive") {
              recorder.stop();
              reject(new Error("The microphone was disconnected. Please reconnect and record again."));
            }
          };
        });
        recorder.start(250);
        timer = setInterval(() => {
          const elapsed = (performance.now() - started) / 1000;
          $("record-status").textContent = `Recording ${time(elapsed)}. Stops automatically at ${time(remaining)}.`;
          if (elapsed >= Math.max(0.1, remaining - 0.5) && recorder.state !== "inactive") recorder.stop();
        }, 200);
        status("Recording on your device. Press Stop recording when finished.");
        updateControls();
      });
      if (cancelled || task.cancelled) return;
      stream.getTracks().forEach(track => track.stop());
      if (!blob.size) throw new Error("No audio was recorded. Check your microphone and try again.");
      status("Preparing your recording...");
      const channels = await decodeFile(new File([blob], "Recording", { type: blob.type }));
      if (!task.cancelled) {
        const clip = makeClip(`Recording ${new Date().toLocaleTimeString()}`, channels);
        commit([...state.clips, clip], clip.id, "Recording added. Your microphone is now off.");
      }
    } finally {
      clearInterval(timer);
      if (recorder && recorder.state !== "inactive") recorder.stop();
      recorder = null;
      stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
      $("record-status").textContent = "Microphone is off. Permission is requested only when you press Record.";
      task.cancel = null;
    }
  });
}

async function transcribe() {
  await runTask("Preparing speech recognition...", async task => {
    if (!$("model-consent").checked) throw new Error("Allow the speech model download first.");
    const channels = scopeChannels($("text-scope").value);
    let peak = 0;
    for (let i = 0; i < channels[0].length; i++) peak = Math.max(peak, Math.abs((channels[0][i] + channels[1][i]) / 2));
    if (peak < 0.0001) throw new Error("This audio is silent. Choose a recording with speech.");
    const samples = await resample(toBuffer(channels), 16000, 1);
    if (task.cancelled) return;
    speechWorker ??= new Worker("./speech-worker.js", { type: "module" });
    try {
      const result = await workerJob(speechWorker, { samples: samples[0], language: $("language").value }, task);
      if (!task.cancelled) {
        if (!result.text) throw new Error("No speech was recognized. Try clearer audio or choose the spoken language.");
        $("text").value = result.text;
        $("text-source").textContent = `Transcript of ${activeClip().name} (${ $("text-scope").value === "selection" ? "selected range" : "whole clip" }). Review and correct it.`;
        status("Speech transcribed locally. Review the text before using it.");
      }
    } catch (error) {
      speechWorker.terminate(); speechWorker = null;
      throw error;
    } finally { task.cancel = null; }
  });
}

$("add").addEventListener("click", () => $("files").click());
$("files").addEventListener("change", () => { const files = [...$("files").files]; $("files").value = ""; void addFiles(files); });
document.addEventListener("dragover", event => { event.preventDefault(); if (!state.task) $("add").classList.add("drag-over"); });
document.addEventListener("dragleave", event => { if (!event.relatedTarget) $("add").classList.remove("drag-over"); });
document.addEventListener("drop", event => {
  event.preventDefault(); $("add").classList.remove("drag-over");
  if (!state.task) void addFiles(event.dataTransfer.files);
});
$("record").addEventListener("click", recordAudio);
$("stop-record").addEventListener("click", () => { if (recorder?.state !== "inactive") recorder?.stop(); });
$("cancel").addEventListener("click", () => {
  if (!state.task) return;
  state.task.cancelled = true; state.task.cancel?.();
  status("Cancelling task...");
});
$("clear").addEventListener("click", () => attempt(() => {
  commit([], null, "Clips and text cleared. Undo restores clips.");
  speechWorker?.terminate(); speechWorker = null;
}));
$("clip-name").addEventListener("change", () => attempt(() => {
  const clip = activeClip();
  const name = $("clip-name").value.trim();
  if (!name) { $("clip-name").value = clip.name; throw new Error("Clip name cannot be empty."); }
  remember();
  state.clips = state.clips.map(item => item.id === clip.id ? { ...clip, name } : item);
  render(); status("Clip renamed.");
}));
$("join").addEventListener("click", () => attempt(() => {
  const selected = state.clips.filter(clip => clip.checked);
  if (selected.length < 2) throw new Error("Check at least two clips to join.");
  const clip = makeClip("Joined audio", joinAudio(selected.map(item => item.channels)));
  const first = state.clips.indexOf(selected[0]);
  const clips = state.clips.filter(item => !item.checked);
  clips.splice(Math.min(first, clips.length), 0, clip);
  commit(clips, clip.id, "Checked clips joined in workspace order. Undo restores the separate clips.");
}));
$("duplicate").addEventListener("click", () => attempt(() => {
  const clip = activeClip();
  const copy = makeClip(`${clip.name} - copy`, clip.channels);
  const clips = [...state.clips]; clips.splice(state.clips.indexOf(clip) + 1, 0, copy);
  commit(clips, copy.id, "Clip duplicated.");
}));
$("split").addEventListener("click", () => attempt(splitClip));
for (const [id, effect] of [["trim", "trim"], ["cut", "cut"], ["normalize", "normalize"], ["reverse", "reverse"], ["fade-in", "fade-in"], ["fade-out", "fade-out"], ["silence", "silence"], ["apply-gain", "gain"]]) {
  $(id).addEventListener("click", () => attempt(() => edit(effect)));
}
for (const [id, from, to] of [["undo", "undo", "redo"], ["redo", "redo", "undo"]]) {
  $(id).addEventListener("click", () => attempt(() => {
    if (!state[from].length) return;
    stopPlayback(); state[to].push({ clips: state.clips, active: state.active });
    const snapshot = state[from].pop(); state.clips = snapshot.clips; state.active = snapshot.active;
    clearText(); render(true); status(id === "undo" ? "Change undone." : "Change reapplied.");
  }));
}
$("select-all").addEventListener("click", () => { $("start").value = "0"; $("end").value = seconds(activeClip().channels).toFixed(6); drawWaveform(); });
for (const id of ["start", "end"]) $(id).addEventListener("input", () => { stopPlayback(); drawWaveform(); });
$("waveform").addEventListener("pointerdown", event => {
  if (state.task || !activeClip()) return;
  const bounds = $("waveform").getBoundingClientRect();
  dragStart = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * seconds(activeClip().channels);
  stopPlayback(); $("waveform").setPointerCapture(event.pointerId);
  $("start").value = dragStart.toFixed(6);
  $("end").value = Math.max(dragStart, Number($("end").value)).toFixed(6);
  drawWaveform();
});
$("waveform").addEventListener("pointermove", event => {
  if (dragStart === null || state.task) return;
  const bounds = $("waveform").getBoundingClientRect();
  const end = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * seconds(activeClip().channels);
  $("start").value = Math.min(dragStart, end).toFixed(6); $("end").value = Math.max(dragStart, end).toFixed(6);
  drawWaveform();
});
for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) $("waveform").addEventListener(event, () => { dragStart = null; });
new ResizeObserver(() => { if (activeClip()) drawWaveform(); }).observe($("waveform"));
$("play").addEventListener("click", playSelection);
$("stop-play").addEventListener("click", stopPlayback);
$("download").addEventListener("click", exportAudio);
$("model-consent").addEventListener("change", updateControls);
$("transcribe").addEventListener("click", transcribe);
$("text").addEventListener("input", updateControls);
$("save-text").addEventListener("click", () => attempt(() => {
  const text = $("text").value;
  downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), filename("txt"));
  status("Text file created.");
}));
$("copy-text").addEventListener("click", () => runTask("Copying text...", async () => {
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable. Select and copy the text manually, or download it.");
  try { await navigator.clipboard.writeText($("text").value); status("Text copied."); }
  catch { throw new Error("Clipboard permission was denied. Select and copy the text manually, or download it."); }
}));
$("forget-model").addEventListener("click", () => runTask("Removing this tool's cached speech models...", async () => {
  speechWorker?.terminate(); speechWorker = null;
  if (!window.caches) throw new Error("Browser cache controls are unavailable here. Use your browser's site-data settings.");
  const cache = await caches.open("transformers-cache");
  let removed = 0;
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.includes("/Xenova/whisper-tiny/") || path.includes("/Xenova/whisper-base.en/")) {
      if (await cache.delete(request)) removed++;
    }
  }
  status(removed ? "Cached speech models removed. Next transcription will download the selected model again." : "No cached speech models were found. Browser-managed HTTP caches can be cleared in site-data settings.");
}));
window.addEventListener("pagehide", () => {
  stopPlayback(); state.task?.cancel?.(); speechWorker?.terminate();
  recorder?.stream.getTracks().forEach(track => track.stop());
  if (audioContext && audioContext.state !== "closed") void audioContext.close();
});

if (location.protocol === "file:" || !window.AudioContext || !window.OfflineAudioContext || !window.Worker) {
  document.querySelectorAll("button,input,select,textarea").forEach(element => { element.disabled = true; });
  fail(new Error("Use a modern browser and serve this page over HTTPS or localhost. Opening the HTML file directly cannot load audio workers."));
} else {
  if (window.MediaRecorder) {
    for (const format of nativeFormats) {
      if (MediaRecorder.isTypeSupported(format.mime)) {
        const option = document.createElement("option"); option.value = format.value; option.textContent = format.label;
        $("format").append(option);
      }
    }
  }
  render();
  status("Ready. Add a file or record your voice. Audio stays on this device.");
}
