import subprocess
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfiltfilt

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
DRUM_PITCH = {"kick": 36, "snare": 38, "hihat": 42}
STEMS = ("drums", "bass", "vocals", "guitar", "piano", "other")


def detect_bpm(y, sr):
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beats, sr=sr)
    return round(bpm, 1), [round(float(t), 3) for t in beat_times]


def detect_key(y, sr):
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    best = (-2.0, 0, "maior")
    for i in range(12):
        for mode, profile in (("maior", MAJOR), ("menor", MINOR)):
            score = np.corrcoef(chroma, np.roll(profile, i))[0, 1]
            if score > best[0]:
                best = (score, i, mode)
    return f"{NOTE_NAMES[best[1]]} {best[2]}"


def to_wav(path: Path, out: Path):
    y, sr = librosa.load(str(path), sr=44100, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    sf.write(str(out), y.T, sr)


def separate_stems(path: Path, out_dir: Path):
    """Separa com Demucs (6 stems). Devolve (stems, erro)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    wav = out_dir / "input.wav"
    to_wav(path, wav)
    proc = subprocess.run(
        [sys.executable, "-m", "demucs", "-n", "htdemucs_6s", "-o", str(out_dir), str(wav)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        err = proc.stderr or proc.stdout or ""
        if "No module named demucs" in err:
            return {}, "Demucs não está instalado"
        lines = err.strip().splitlines()
        return {}, lines[-1] if lines else "erro desconhecido"
    folder = out_dir / "htdemucs_6s" / "input"
    stems = {n: folder / f"{n}.wav" for n in STEMS if (folder / f"{n}.wav").exists()}
    return stems, (None if stems else "O Demucs não gerou arquivos")


PARAMS = {
    "bass":   dict(minf=30.0, maxf=350.0, onset=0.6, frame=0.4, minlen=90.0, minvel=0.25, mono=True),
    "vocals": dict(minf=80.0, maxf=1100.0, onset=0.65, frame=0.45, minlen=110.0, minvel=0.3, mono=True),
    "guitar": dict(minf=80.0, maxf=1400.0, onset=0.6, frame=0.4, minlen=90.0, minvel=0.25, mono=False),
    "piano":  dict(minf=50.0, maxf=2100.0, onset=0.6, frame=0.4, minlen=90.0, minvel=0.25, mono=False),
    "other":  dict(minf=60.0, maxf=2100.0, onset=0.65, frame=0.45, minlen=100.0, minvel=0.3, mono=False),
    "mix":    dict(minf=50.0, maxf=2000.0, onset=0.65, frame=0.45, minlen=100.0, minvel=0.3, mono=False),
}


def merge_same_pitch(notes, gap=0.06):
    out, last = [], {}
    for n in sorted(notes, key=lambda n: n["start"]):
        prev = last.get(n["pitch"])
        if prev and n["start"] - (prev["start"] + prev["duration"]) <= gap:
            end = max(prev["start"] + prev["duration"], n["start"] + n["duration"])
            prev["duration"] = round(end - prev["start"], 3)
            prev["velocity"] = max(prev["velocity"], n["velocity"])
        else:
            out.append(n)
            last[n["pitch"]] = n
    return out


def make_mono(notes):
    """Instrumentos de uma nota só por vez (baixo, voz): mantém a mais forte."""
    out = []
    for n in sorted(notes, key=lambda n: n["start"]):
        if out and n["start"] < out[-1]["start"] + out[-1]["duration"]:
            prev = out[-1]
            if n["velocity"] >= prev["velocity"]:
                prev["duration"] = round(max(0.0, n["start"] - prev["start"]), 3)
                if prev["duration"] < 0.05:
                    out.pop()
                out.append(n)
        else:
            out.append(n)
    return out


def energy_gate(notes, path: Path, ratio=0.12):
    """Remove notas em trechos quase silenciosos do stem (vazamento de outros instrumentos)."""
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    rms = librosa.feature.rms(y=y, hop_length=512)[0]
    if rms.size == 0:
        return notes
    limit = float(np.percentile(rms, 95)) * ratio
    kept = []
    for n in notes:
        i = min(rms.size - 1, int(n["start"] * sr / 512))
        j = min(rms.size, i + max(1, int(n["duration"] * sr / 512)))
        if float(rms[i:j].mean()) >= limit:
            kept.append(n)
    return kept


def activity_segments(path: Path, ratio=0.06, min_gap=0.12, min_len=0.05):
    """Trechos em que o stem realmente tem som (inclui respiração e reverb)."""
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    if rms.size == 0:
        return []
    active = rms >= float(np.percentile(rms, 95)) * ratio
    segs, start = [], None
    for i, a in enumerate(active):
        if a and start is None:
            start = i
        elif not a and start is not None:
            segs.append((start, i))
            start = None
    if start is not None:
        segs.append((start, len(active)))
    merged = []
    for s0, e0 in segs:
        a0, b0 = round(float(s0 * hop / sr), 3), round(float(e0 * hop / sr), 3)
        if merged and a0 - merged[-1][1] <= min_gap:
            merged[-1][1] = b0
        else:
            merged.append([a0, b0])
    return [m for m in merged if m[1] - m[0] >= min_len]


# ---------- grade rítmica ----------

def beat_grid(beats, sub):
    """Subdivisões (sub por tempo) interpoladas entre as batidas detectadas, acompanhando a deriva do andamento."""
    b = np.array(beats, dtype=float)
    if len(b) < 2:
        return np.array([])
    step = float(np.median(np.diff(b)))
    ext = np.concatenate([[b[0] - step * k for k in range(8, 0, -1)], b, [b[-1] + step * k for k in range(1, 9)]])
    grid = []
    for i in range(len(ext) - 1):
        for k in range(sub):
            grid.append(ext[i] + (ext[i + 1] - ext[i]) * k / sub)
    grid.append(ext[-1])
    g = np.array(grid)
    return g[g >= 0]


def snap_time(t, grid, tol=0.45):
    if grid.size == 0:
        return t
    i = int(np.searchsorted(grid, t))
    lo = grid[max(i - 1, 0)]
    hi = grid[min(i, len(grid) - 1)]
    cand = lo if abs(t - lo) <= abs(hi - t) else hi
    spacing = float(hi - lo) if hi > lo else 0.1
    return float(cand) if abs(cand - t) <= tol * spacing else float(t)


def quantize_notes(notes, grid):
    """Música eletrônica é programada na grade: alinha início e fim das notas a 1/16."""
    if grid.size < 2:
        return notes
    step = float(np.median(np.diff(grid)))
    out = []
    for n in notes:
        s = snap_time(n["start"], grid)
        e = snap_time(n["start"] + n["duration"], grid)
        if e - s < step * 0.9:
            e = s + step
        out.append({**n, "start": round(s, 3), "duration": round(e - s, 3)})
    return out


# ---------- bateria ----------

DRUM_BANDS = {
    "kick": dict(pitch=36, lo=30.0, hi=160.0, delta=0.10, wait=0.07, dur=0.2, sub=4),
    "snare": dict(pitch=38, lo=900.0, hi=4500.0, delta=0.12, wait=0.08, dur=0.15, sub=4),
    "hat": dict(pitch=42, lo=6500.0, hi=10500.0, delta=0.10, wait=0.035, dur=0.06, sub=8),
}


def _refine(yb, sr, t0):
    a = int(max(0, (t0 - 0.015) * sr))
    b = int(min(len(yb), (t0 + 0.07) * sr))
    seg = np.abs(yb[a:b])
    if seg.size == 0:
        return t0
    k = max(1, int(0.0015 * sr))
    env = np.convolve(seg, np.ones(k) / k, mode="same")
    peak = float(env.max())
    if peak <= 0:
        return t0
    return (a + int(np.argmax(env > 0.35 * peak))) / sr


def _band_onsets(y, sr, p):
    sos = butter(4, [p["lo"], min(p["hi"], sr / 2 - 100)], btype="band", fs=sr, output="sos")
    yb = sosfiltfilt(sos, y)
    hop = 128
    env = librosa.onset.onset_strength(y=yb, sr=sr, hop_length=hop, n_fft=1024)
    env = env / (float(np.percentile(env, 99)) + 1e-9)
    frames = librosa.util.peak_pick(
        env,
        pre_max=int(0.03 * sr / hop),
        post_max=int(0.03 * sr / hop),
        pre_avg=int(0.1 * sr / hop),
        post_avg=int(0.1 * sr / hop),
        delta=p["delta"],
        wait=int(p["wait"] * sr / hop),
    )
    hits = []
    for f in frames:
        if min(1.0, float(env[f])) < 0.25:
            continue
        t = _refine(yb, sr, float(f * hop / sr))
        a0, b0 = int(t * sr), int((t + 0.06) * sr)
        amp = float(np.sqrt(np.mean(yb[a0:b0] ** 2))) if b0 > a0 else 0.0
        hits.append((t, amp))
    if not hits:
        return []
    ref = float(np.percentile([h[1] for h in hits], 75)) + 1e-12
    # força relativa à batida típica da faixa; vazamento de outras peças fica fraco e cai fora
    out = [(t, min(1.0, amp / ref)) for t, amp in hits]
    return [(t, s0) for t, s0 in out if s0 >= 0.35]


def detect_drums(path: Path, beats):
    """Kick, snare e hi-hat por faixa de frequência, alinhados à grade. Devolve (notas, deslocamento da grade)."""
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    raw = {k: _band_onsets(y, sr, p) for k, p in DRUM_BANDS.items()}

    # a grade do beat tracking pode estar atrasada/adiantada: acerta pela posição real dos kicks e snares
    grid4 = beat_grid(beats, 4)
    shift = 0.0
    if grid4.size:
        res = []
        for k in ("kick", "snare"):
            for t, _ in raw[k]:
                i = int(np.searchsorted(grid4, t))
                lo, hi = grid4[max(i - 1, 0)], grid4[min(i, len(grid4) - 1)]
                near = lo if abs(t - lo) <= abs(hi - t) else hi
                spacing = float(hi - lo) if hi > lo else 0.1
                if abs(t - near) < 0.25 * spacing:
                    res.append(t - near)
        if len(res) >= 8:
            shift = float(np.median(res))

    shifted = [max(0.0, b + shift) for b in beats]
    notes = []
    for k, p in DRUM_BANDS.items():
        grid = beat_grid(shifted, p["sub"])
        seen = set()
        for t, strength in raw[k]:
            ts = round(snap_time(t, grid), 3)
            if ts in seen:
                continue
            seen.add(ts)
            notes.append({"pitch": p["pitch"], "start": ts, "duration": p["dur"], "velocity": round(strength, 2)})
    return sorted(notes, key=lambda n: n["start"]), shift


# ---------- vocal: uma faixa por frase ----------

def vocal_phrases(path: Path):
    segs = activity_segments(path, ratio=0.1, min_gap=0.4, min_len=0.3)
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    rms = librosa.feature.rms(y=y, hop_length=512)[0]
    ref = float(np.percentile(rms, 95)) + 1e-9
    clips = []
    for a, b in segs:
        i = int(a * sr / 512)
        j = max(i + 1, int(b * sr / 512))
        v = float(rms[i:j].mean() / ref)
        clips.append({"pitch": 60, "start": a, "duration": round(b - a, 3), "velocity": round(min(1.0, max(0.3, v)), 2), "src": a})
    return clips


# ---------- instrumentos melódicos ----------

def harmonic_copy(path: Path) -> Path:
    """Tira transientes (bateria que vaza no stem) antes de transcrever."""
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    yh = librosa.effects.harmonic(y, margin=3.0)
    out = path.with_name(path.stem + "_harm.wav")
    sf.write(str(out), yh, sr)
    return out


def transcribe(path: Path, instrument: str = "mix", grid=None):
    from basic_pitch.inference import predict

    p = PARAMS.get(instrument, PARAMS["mix"])
    src = path if instrument == "bass" else harmonic_copy(path)
    _, _, events = predict(
        str(src),
        onset_threshold=p["onset"],
        frame_threshold=p["frame"],
        minimum_note_length=p["minlen"],
        minimum_frequency=p["minf"],
        maximum_frequency=p["maxf"],
    )
    notes = [
        {
            "pitch": int(pitch),
            "start": round(float(start), 3),
            "duration": round(float(end - start), 3),
            "velocity": round(min(1.0, float(amp)), 2),
        }
        for start, end, pitch, amp, _ in events
    ]
    notes = [n for n in notes if n["duration"] >= 0.06 and n["velocity"] >= p["minvel"]]
    notes = merge_same_pitch(notes)
    if p["mono"]:
        notes = make_mono(notes)
    notes = energy_gate(notes, path)
    if grid is not None:
        notes = merge_same_pitch(quantize_notes(notes, grid), gap=0.0)
        if p["mono"]:
            notes = make_mono(notes)
    return sorted(notes, key=lambda n: n["start"])


def classify_instrument(stem: str, notes) -> str:
    """Nome no estilo do FL Studio, estimado pelo comportamento das notas (o usuário pode trocar)."""
    if not notes:
        return "other"
    pitches = np.array([n["pitch"] for n in notes])
    durs = np.array([n["duration"] for n in notes])
    med_p, med_d = float(np.median(pitches)), float(np.median(durs))
    if stem == "bass":
        return "bass808" if med_p <= 40 and med_d >= 0.3 else "bass"
    spans = sorted((n["start"], n["start"] + n["duration"]) for n in notes)
    active, cur_s, cur_e = 0.0, spans[0][0], spans[0][1]
    for s0, e0 in spans[1:]:
        if s0 <= cur_e:
            cur_e = max(cur_e, e0)
        else:
            active += cur_e - cur_s
            cur_s, cur_e = s0, e0
    active += cur_e - cur_s
    poly = float(durs.sum()) / max(active, 1e-6)
    if med_p >= 78 and poly < 2:
        return "bell"
    if poly >= 2.6 and med_d >= 0.6:
        return "strings" if stem == "other" and med_p < 60 else "pad"
    if poly >= 1.8 and med_d < 0.6:
        return "piano" if stem == "piano" else "keys"
    if poly >= 1.8 and stem == "guitar" and med_d >= 0.35:
        return "guitar"
    if med_d < 0.22:
        return "pluck"
    if stem == "piano":
        return "piano"
    return "lead"


def analyze_file(path: Path, work_dir: Path):
    job = work_dir.name
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    bpm, beats = detect_bpm(y, sr)
    key = detect_key(y, sr)
    duration = round(float(len(y) / sr), 2)

    stems, sep_error = separate_stems(path, work_dir)
    drums_src = stems.get("drums", path)
    drum_notes, shift = detect_drums(drums_src, beats)
    beats = [round(max(0.0, b + shift), 3) for b in beats]
    grid16 = beat_grid(beats, 4)

    def stem_url(name):
        return f"/api/stem/{job}/{name}" if name in stems else None

    tracks = [
        {"id": "drums", "name": "Bateria", "instrument": "drums", "kind": "drums", "audio": stem_url("drums"), "segments": [], "notes": drum_notes}
    ]

    if stems:
        if "vocals" in stems:
            phrases = vocal_phrases(stems["vocals"])
            if phrases:
                tracks.append({"id": "vocals", "name": "Vocal", "instrument": "vocals", "kind": "clips", "audio": stem_url("vocals"), "segments": [], "notes": phrases})
        for name in ("bass", "guitar", "piano", "other"):
            if name not in stems:
                continue
            notes = transcribe(stems[name], name, grid16)
            if len(notes) >= 8:
                tracks.append(
                    {
                        "id": name,
                        "name": name,
                        "instrument": classify_instrument(name, notes),
                        "kind": "melodic",
                        "audio": stem_url(name),
                        "segments": activity_segments(stems[name]) if name == "bass" else [],
                        "notes": notes,
                    }
                )
    else:
        tracks.append(
            {"id": "mix", "name": "Mix completo", "instrument": "mix", "kind": "melodic", "audio": f"/api/audio/{job}", "segments": [], "notes": transcribe(path, "mix", grid16)}
        )

    return {
        "name": path.stem,
        "bpm": bpm,
        "key": key,
        "duration": duration,
        "beats": beats,
        "separated": bool(stems),
        "separation_error": sep_error,
        "tracks": tracks,
    }
