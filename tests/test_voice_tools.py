"""Browser regressions using synthetic audio, fake microphone, and mocked clipboard."""
import array
from functools import partial
import http.server
import math
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
import wave

import imageio_ffmpeg
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BROWSER = os.environ.get("VOICE_TEST_BROWSER", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def fixture(path, frequency=440, duration=2, silent=False):
    pcm = array.array("h")
    for i in range(round(44100 * duration)):
        value = 0 if silent else round(math.sin(2 * math.pi * frequency * i / 44100) * 8000)
        pcm.extend([value, round(value / 2)])
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(44100)
        output.writeframes(pcm.tobytes())


class VoiceToolsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.temp.name)
        fixture(cls.dir / "first.wav")
        fixture(cls.dir / "second.wav", 880, 1)
        fixture(cls.dir / "silence.wav", silent=True)
        (cls.dir / "broken.wav").write_bytes(b"not audio")
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://localhost:{cls.server.server_port}/"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=BROWSER,
            args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
                  f"--use-file-for-fake-audio-capture={cls.dir / 'first.wav'}"],
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def setUp(self):
        self.context = self.browser.new_context(accept_downloads=True, permissions=["microphone"])
        self.context.route("**/*cloudflareinsights.com/**", lambda route: route.abort())
        self.context.add_init_script("""
          Object.defineProperty(navigator, 'clipboard', {value: {
            writeText: async text => { window.copiedText = text; }
          }});
        """)
        self.requests = []
        self.context.on("request", lambda request: self.requests.append(request))
        self.page = self.context.new_page()
        self.page.goto(self.url)
        self.page.wait_for_function("!document.querySelector('#add').disabled")

    def tearDown(self):
        self.context.close()

    def ready(self):
        self.page.wait_for_function("document.querySelector('#progress').hidden", timeout=120000)

    def load(self, *names):
        self.page.locator("#files").set_input_files([self.dir / name for name in names])
        self.ready()
        self.assertTrue(self.page.locator("#error").is_hidden(), self.page.locator("#error").text_content())

    def range(self, first, last):
        self.page.locator("#start").fill(str(first))
        self.page.locator("#end").fill(str(last))

    def save(self, format="wav", scope="clip"):
        self.page.locator("#format").select_option(format)
        self.page.locator("#export-scope").select_option(scope)
        with self.page.expect_download(timeout=30000) as event:
            self.page.locator("#download").click()
        path = self.dir / f"output-{time.time_ns()}.{format}"
        event.value.save_as(path)
        self.ready()
        return path

    def wav_duration(self, path):
        with wave.open(str(path)) as audio:
            self.assertEqual(audio.getnchannels(), 2)
            return audio.getnframes() / audio.getframerate()

    def decode(self, path):
        result = subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i", str(path),
             "-f", "wav", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", "pipe:1"],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        output = self.dir / f"decoded-{time.time_ns()}.wav"
        output.write_bytes(result.stdout)
        return output

    def test_range_editing_split_join_order_and_undo(self):
        self.load("first.wav", "second.wav")
        self.range(0.5, 1.5)
        self.page.locator("#trim").click()
        self.assertAlmostEqual(self.wav_duration(self.save()), 1, places=4)
        self.page.locator("#undo").click()
        self.assertAlmostEqual(self.wav_duration(self.save()), 2, places=4)
        self.page.locator("#redo").click()
        self.range(0.25, 0.75)
        self.page.locator("#cut").click()
        self.assertAlmostEqual(self.wav_duration(self.save()), 0.5, places=4)
        self.range(0.25, 0.5)
        self.page.locator("#split").click()
        self.assertEqual(self.page.locator(".clip").count(), 3)
        self.page.get_by_role("button", name="Move up: second", exact=True).click()
        self.page.locator("#join").click()
        joined = self.save()
        self.assertEqual(self.page.locator(".clip").count(), 1)
        self.assertAlmostEqual(self.wav_duration(joined), 1.5, places=4)
        with wave.open(str(joined)) as audio:
            pcm = array.array("h", audio.readframes(audio.getnframes()))
        # First quarter second is 440 Hz; the moved second clip follows at 880 Hz.
        for start, frequency in [(0.05, 440), (0.3, 880), (1.3, 440)]:
            offset = round(start * 44100)
            values = pcm[offset * 2:(offset + 4410) * 2:2]
            crossings = sum(a < 0 <= b for a, b in zip(values, values[1:]))
            self.assertAlmostEqual(crossings / 0.1, frequency, delta=15)

    def test_effect_samples_and_range_validation(self):
        result = self.page.evaluate("""async () => {
          const a = await import('./audio-utils.js');
          const channels = [new Float32Array([0.1, 0.2, -0.4, 0.8]), new Float32Array([0, -0.2, 0.2, 0.4])];
          const result = {};
          for (const effect of ['reverse','normalize','fade-in','fade-out','silence','gain'])
            result[effect] = Array.from(a.applyEffect(channels, 1, 4, effect, 20)[0]);
          result.original = Array.from(channels[0]);
          try { a.frameRange(2, 1, 44100); result.invalid = false; } catch { result.invalid = true; }
          return result;
        }""")
        self.assertTrue(result["invalid"])
        self.assertAlmostEqual(result["reverse"][1], 0.8, places=6)
        self.assertAlmostEqual(result["reverse"][3], 0.2, places=6)
        self.assertAlmostEqual(result["normalize"][3], 0.95, places=6)
        self.assertAlmostEqual(result["gain"][3], 1, places=6)
        self.assertEqual(result["fade-in"][1], 0)
        self.assertEqual(result["fade-out"][3], 0)
        self.assertEqual(result["silence"][1:], [0, 0, 0])
        self.assertAlmostEqual(result["original"][1], 0.2, places=6)
        self.load("first.wav")
        self.range(-1, 1)
        self.page.locator("#trim").click()
        self.assertTrue(self.page.locator("#error").is_visible())
        self.range(0, 2)
        self.page.locator("#cut").click()
        self.assertIn("entire clip", self.page.locator("#error").text_content())
        self.assertAlmostEqual(self.wav_duration(self.save()), 2, places=4)

    def test_wav_mp3_native_export_and_cancel(self):
        self.load("first.wav")
        self.range(0.25, 1.25)
        self.assertAlmostEqual(self.wav_duration(self.save(scope="selection")), 1, places=4)
        mp3 = self.save("mp3", "selection")
        self.assertGreater(mp3.stat().st_size, 1000)
        decoded = self.decode(mp3)
        with wave.open(str(decoded)) as audio:
            pcm = array.array("h", audio.readframes(round(44100 * 1.2)))
        self.assertGreater(len(pcm), 44100 * 2 * 0.9)
        self.assertLess(len(pcm), 44100 * 2 * 1.2)
        self.assertGreater(max(pcm), 5000)
        formats = self.page.locator("#format option").evaluate_all("options => options.map(x => x.value)")
        for format in formats:
            if format in ("wav", "mp3"):
                continue
            output = self.save(format, "selection")
            self.assertGreater(self.decode(output).stat().st_size, 150000)
        if "webm" in formats:
            self.page.locator("#format").select_option("webm")
            self.page.locator("#download").click()
            self.page.locator("#cancel").click()
            self.ready()
            self.assertIn("cancelled", self.page.locator("#status").text_content())
        self.assertFalse(any(request.method != "GET" for request in self.requests))
        self.assertFalse(any("huggingface" in request.url for request in self.requests))

    def test_recording_text_and_failure_recovery(self):
        self.page.locator("#record").click()
        self.page.wait_for_function("!document.querySelector('#stop-record').disabled")
        self.page.wait_for_timeout(1600)
        self.page.locator("#stop-record").click()
        self.ready()
        self.assertEqual(self.page.locator(".clip").count(), 1)
        self.assertIn("Microphone is off", self.page.locator("#record-status").text_content())
        output = self.save()
        self.assertGreater(self.wav_duration(output), 1)
        self.page.locator("#text").fill("Hello world. Hola, mundo.")
        self.page.locator("#copy-text").click()
        self.ready()
        self.assertEqual(self.page.evaluate("window.copiedText"), "Hello world. Hola, mundo.")
        with self.page.expect_download() as event:
            self.page.locator("#save-text").click()
        textfile = self.dir / "transcript.txt"
        event.value.save_as(textfile)
        self.assertEqual(textfile.read_text(encoding="utf-8"), "Hello world. Hola, mundo.")
        self.page.locator("#files").set_input_files(self.dir / "broken.wav")
        self.ready()
        self.assertTrue(self.page.locator("#error").is_visible())
        self.assertEqual(self.page.locator(".clip").count(), 1)
        self.load("second.wav")
        self.assertEqual(self.page.locator(".clip").count(), 2)

    def test_compressed_mono_inputs_and_transactional_import(self):
        self.load("first.wav")
        encoded = self.save("mp3")
        self.load(encoded)
        self.assertAlmostEqual(self.wav_duration(self.save()), 2, delta=0.1)
        flac = self.dir / "mono-24000.flac"
        subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-y", "-i",
             str(self.dir / "first.wav"), "-ar", "24000", "-ac", "1", str(flac)],
            check=True, capture_output=True,
        )
        self.load(flac)
        wav = self.save()
        with wave.open(str(wav)) as audio:
            self.assertEqual(audio.getframerate(), 44100)
            pcm = array.array("h", audio.readframes(audio.getnframes()))
            self.assertEqual(pcm[::2], pcm[1::2])
        count = self.page.locator(".clip").count()
        self.page.locator("#files").set_input_files([self.dir / "second.wav", self.dir / "broken.wav"])
        self.ready()
        self.assertTrue(self.page.locator("#error").is_visible())
        self.assertEqual(self.page.locator(".clip").count(), count)

    def test_recording_cancellation_releases_microphone(self):
        errors = []
        self.page.on("pageerror", lambda error: errors.append(error))
        self.page.locator("#record").click()
        self.page.wait_for_function("!document.querySelector('#stop-record').disabled")
        self.page.wait_for_timeout(600)
        self.page.locator("#cancel").click()
        self.ready()
        self.page.wait_for_timeout(300)
        self.assertEqual(self.page.locator(".clip").count(), 0)
        self.assertIn("Microphone is off", self.page.locator("#record-status").text_content())
        self.assertTrue(self.page.locator("#record").is_enabled())
        self.assertEqual(errors, [])

    def test_silence_model_failure_retry_and_mobile(self):
        self.load("silence.wav")
        self.page.locator("#model-consent").check()
        self.page.locator("#transcribe").click()
        self.ready()
        self.assertIn("silent", self.page.locator("#error").text_content())
        self.load("first.wav")
        self.context.route("**/speech-worker.js", lambda route: route.abort())
        self.page.locator("#transcribe").click()
        self.ready()
        self.assertTrue(self.page.locator("#error").is_visible())
        self.assertTrue(self.page.locator("#transcribe").is_enabled())
        self.context.unroute("**/speech-worker.js")
        self.page.set_viewport_size({"width": 375, "height": 800})
        self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        self.assertTrue(self.page.locator("#download").is_visible())

    def test_cache_cleanup_preserves_unrelated_models(self):
        self.page.evaluate("""async () => {
          const cache = await caches.open('transformers-cache');
          for (const model of ['whisper-base.en', 'whisper-tiny', 'unrelated-model'])
            await cache.put(`https://huggingface.co/Xenova/${model}/resolve/main/config.json`, new Response('{}'));
        }""")
        self.page.locator("#forget-model").click()
        self.ready()
        paths = self.page.evaluate("""async () =>
          (await (await caches.open('transformers-cache')).keys()).map(request => new URL(request.url).pathname)
        """)
        self.assertEqual(paths, ["/Xenova/unrelated-model/resolve/main/config.json"])

    @unittest.skipUnless(os.environ.get("VOICE_TEST_SPEECH"), "Set VOICE_TEST_SPEECH for actual English model inference")
    def test_real_speech_recognition(self):
        self.page.locator("#files").set_input_files(os.environ["VOICE_TEST_SPEECH"])
        self.ready()
        self.page.locator("#model-consent").check()
        self.page.locator("#language").select_option("english")
        self.page.locator("#transcribe").click()
        self.page.wait_for_function("document.querySelector('#progress').hidden", timeout=600000)
        self.assertTrue(self.page.locator("#error").is_hidden(), self.page.locator("#error").text_content())
        text = self.page.locator("#text").input_value().lower()
        self.assertIn("hello", text)
        self.assertIn("world", text)
        self.assertTrue(any("/Xenova/whisper-base.en/" in request.url for request in self.requests))
        self.assertFalse(any("/Xenova/whisper-tiny/" in request.url for request in self.requests))
        self.assertFalse(any(request.method != "GET" for request in self.requests))

    @unittest.skipUnless(os.environ.get("VOICE_TEST_SPEECH") and os.environ.get("VOICE_TEST_SPANISH"),
                         "Set English and Spanish fixtures to verify model switching")
    def test_switching_speech_models(self):
        self.page.locator("#model-consent").check()
        for language, fixture_env, expected, model in [
            ("english", "VOICE_TEST_SPEECH", "world", "whisper-base.en"),
            ("spanish", "VOICE_TEST_SPANISH", "mundo", "whisper-tiny"),
            ("", "VOICE_TEST_SPANISH", "mundo", "whisper-tiny"),
            ("english", "VOICE_TEST_SPEECH", "world", "whisper-base.en"),
        ]:
            first_request = len(self.requests)
            self.page.locator("#files").set_input_files(os.environ[fixture_env])
            self.ready()
            self.page.locator("#language").select_option(language)
            self.page.locator("#transcribe").click()
            self.page.wait_for_function("document.querySelector('#progress').hidden", timeout=600000)
            self.assertTrue(self.page.locator("#error").is_hidden(), self.page.locator("#error").text_content())
            self.assertIn(expected, self.page.locator("#text").input_value().lower())
            wrong_model = "whisper-tiny" if model == "whisper-base.en" else "whisper-base.en"
            self.assertFalse(any(f"/Xenova/{wrong_model}/" in request.url for request in self.requests[first_request:]))
        self.assertFalse(any(request.method != "GET" for request in self.requests))


if __name__ == "__main__":
    unittest.main()
