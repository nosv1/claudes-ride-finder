"""Record Ride mode's voice: every phrase in voice/phrases.json, in each voice below, as voice/<id>/<key>.<ext>, and
voice/voices.json listing the voices. Ride mode plays these clips instead of the phone's own voice because on iPhone
an audio file plays over the rider's music, while the phone's voice stops it (found with sound-check.html).

Engines:
  windows  this PC's built-in voices (System.Speech, through PowerShell). Robotic, but always there.
  kokoro   natural voices from Kokoro (kokoro-onnx). Needs `pip install kokoro-onnx soundfile` and the model files
           kokoro-v1.0.int8.onnx and voices-v1.0.bin in raw/kokoro/ (github.com/thewh1teagle/kokoro-onnx releases).
Each clip is trimmed of silence and turned up to just under full volume, so it carries over music.

Usage (from the repo root):  python tools/make_voice.py            every voice whose engine is available
                             python tools/make_voice.py zira       just these
"""
import json
import os
import subprocess
import sys
import tempfile
import wave
from array import array

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'voice')
KOKORO = os.path.join(ROOT, 'raw', 'kokoro')

# id, the name shown in the app, engine, the engine's name for the voice. The first one available is the default.
# chime: a beep-boop before each thing it says (voice/chime.wav), so a robotic voice comes across as a robot calling in
# rather than one trying to pass for a person.
VOICES = [
    {'id': 'heart', 'label': 'Heart', 'engine': 'kokoro', 'voice': 'af_heart'},
    {'id': 'michael', 'label': 'Michael', 'engine': 'kokoro', 'voice': 'am_michael'},
    {'id': 'emma', 'label': 'Emma (British)', 'engine': 'kokoro', 'voice': 'bf_emma'},
    {'id': 'zira', 'label': 'Zira (robot)', 'engine': 'windows', 'voice': 'Microsoft Zira Desktop', 'chime': True},
    {'id': 'david', 'label': 'David (robot)', 'engine': 'windows', 'voice': 'Microsoft David Desktop', 'chime': True},
]
RATE = 16000
PEAK = 0.93          # of full scale
QUIET = 0.02         # below this (of full scale) is silence, for trimming
PAD_S = 0.06         # silence kept at each end


def kokoro_ready():
    try:
        import kokoro_onnx  # noqa: F401
    except ImportError:
        return False
    return os.path.exists(os.path.join(KOKORO, 'kokoro-v1.0.int8.onnx')) and os.path.exists(os.path.join(KOKORO, 'voices-v1.0.bin'))


def windows_ready():
    return sys.platform == 'win32'


READY = {'kokoro': kokoro_ready, 'windows': windows_ready}


def resample(samples, src, dst):
    """Linear resampling of int samples from rate src to dst."""
    if src == dst:
        return samples
    n = int(len(samples) * dst / src)
    out = array('h', [0]) * n
    for i in range(n):
        x = i * src / dst
        j = int(x)
        f = x - j
        a = samples[j] if j < len(samples) else 0
        b = samples[j + 1] if j + 1 < len(samples) else a
        out[i] = int(a + (b - a) * f)
    return out


def finish(samples, rate, path):
    """Trim silence, normalize, write 16-bit mono WAV at RATE."""
    samples = resample(samples, rate, RATE)
    loud = max((abs(s) for s in samples), default=0) or 1
    cut = QUIET * loud
    first = next((i for i, s in enumerate(samples) if abs(s) > cut), 0)
    last = next((i for i in range(len(samples) - 1, -1, -1) if abs(samples[i]) > cut), len(samples) - 1)
    pad = int(PAD_S * RATE)
    clip = samples[max(0, first - pad):min(len(samples), last + pad)]
    k = PEAK * 32767 / loud
    clip = array('h', (max(-32768, min(32767, int(s * k))) for s in clip))
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(clip.tobytes())


def read_wav(path):
    with wave.open(path, 'rb') as w:
        assert w.getsampwidth() == 2 and w.getnchannels() == 1
        return array('h', w.readframes(w.getnframes())), w.getframerate()


def record_windows(v, phrases, folder):
    with tempfile.TemporaryDirectory() as tmp:
        jobs = [{'text': text, 'out': os.path.join(tmp, f'{key}.wav')} for key, text in phrases.items()]
        listing = os.path.join(tmp, 'jobs.json')
        with open(listing, 'w', encoding='utf-8') as f:
            json.dump(jobs, f)
        script = (
            'Add-Type -AssemblyName System.Speech;'
            f"$jobs = Get-Content -Raw -Encoding UTF8 '{listing}' | ConvertFrom-Json;"
            '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);'
            '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;'
            f"$s.SelectVoice('{v['voice']}');"
            'foreach ($j in $jobs) { $s.SetOutputToWaveFile($j.out, $fmt); $s.Speak($j.text) };'
            '$s.Dispose()'
        )
        subprocess.run(['powershell', '-NoProfile', '-Command', script], check=True)
        for key in phrases:
            samples, rate = read_wav(os.path.join(tmp, f'{key}.wav'))
            finish(samples, rate, os.path.join(folder, f'{key}.wav'))


def record_kokoro(v, phrases, folder):
    from kokoro_onnx import Kokoro
    tts = Kokoro(os.path.join(KOKORO, 'kokoro-v1.0.int8.onnx'), os.path.join(KOKORO, 'voices-v1.0.bin'))
    lang = 'en-gb' if v['voice'].startswith('b') else 'en-us'
    for key, text in phrases.items():
        audio, rate = tts.create(text, voice=v['voice'], speed=1.0, lang=lang)
        samples = array('h', (int(max(-1.0, min(1.0, float(x))) * 32767) for x in audio))
        finish(samples, rate, os.path.join(folder, f'{key}.wav'))


RECORD = {'windows': record_windows, 'kokoro': record_kokoro}


def make_chime(path):
    """Beep-boop: a high note then a lower one, a little square-edged (odd harmonics) like an old computer, each with a
    quick fade in and out so it doesn't click."""
    import math
    out = array('h')
    for hz, s, gap in [(1318.5, 0.085, 0.035), (987.8, 0.12, 0.0)]:   # E6, then B5
        n = int(s * RATE)
        for i in range(n):
            t = i / RATE
            env = min(1.0, i / (0.006 * RATE), (n - i) / (0.025 * RATE))
            wave_ = math.sin(2 * math.pi * hz * t) + math.sin(6 * math.pi * hz * t) / 3 + math.sin(10 * math.pi * hz * t) / 5
            out.append(int(0.6 * PEAK * 32767 * env * wave_ / 1.5))
        out.extend([0] * int(gap * RATE))
    out.extend([0] * int(0.08 * RATE))   # a breath before the words
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(out.tobytes())


def main(ids):
    with open(os.path.join(OUT, 'phrases.json'), encoding='utf-8') as f:
        phrases = json.load(f)
    listing = os.path.join(OUT, 'voices.json')
    made = json.load(open(listing, encoding='utf-8')) if os.path.exists(listing) else []
    for v in VOICES:
        if ids and v['id'] not in ids:
            continue
        if not READY[v['engine']]():
            print(f"skip {v['id']}: the {v['engine']} engine isn't set up")
            continue
        folder = os.path.join(OUT, v['id'])
        os.makedirs(folder, exist_ok=True)
        RECORD[v['engine']](v, phrases, folder)
        made = [m for m in made if m['id'] != v['id']] + [{'id': v['id'], 'label': v['label'], 'ext': 'wav', **({'chime': True} if v.get('chime') else {})}]
        size = sum(os.path.getsize(os.path.join(folder, f)) for f in os.listdir(folder))
        print(f"{v['id']}: {len(phrases)} clips, {size // 1024} KB")
    make_chime(os.path.join(OUT, 'chime.wav'))
    order = [v['id'] for v in VOICES]
    made.sort(key=lambda m: order.index(m['id']) if m['id'] in order else len(order))
    with open(listing, 'w', encoding='utf-8') as f:
        json.dump(made, f, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main(sys.argv[1:])
