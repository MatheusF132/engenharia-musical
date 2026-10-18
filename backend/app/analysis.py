import subprocess
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
DRUM_PITCH = {"kick": 36, "snare": 38, "hihat": 42}
STEMS = ("drums", "bass", "vocals", "guitar", "piano", "other")
LABELS = {"bass": "Baixo", "vocals": "Voz", "guitar": "Guitarra / violão", "piano": "Piano / teclas", "other": "Outros", "drums": "Bateria", "mix": "Mix completo"}


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


def transcribe(path: Path):
    from basic_pitch.inference import predict

    _, _, events = predict(str(path))
    notes = [
        {
            "pitch": int(pitch),
            "start": round(float(start), 3),
            "duration": round(float(end - start), 3),
            "velocity": round(min(1.0, float(amp)), 2),
        }
        for start, end, pitch, amp, _ in events
    ]
    return sorted(notes, key=lambda n: n["start"])


def detect_drums(path: Path):
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    hop = 512
    frames = librosa.onset.onset_detect(y=y, sr=sr, hop_length=hop, units="frames")
    spec = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    low = spec[freqs < 150].sum(axis=0)
    mid = spec[(freqs >= 150) & (freqs < 2500)].sum(axis=0)
    high = spec[freqs >= 5000].sum(axis=0)

    notes = []
    for f in frames:
        l, m, h = low[f : f + 3].sum(), mid[f : f + 3].sum(), high[f : f + 3].sum()
        total = l + m + h + 1e-9
        if l / total > 0.5:
            kind = "kick"
        elif h / total > 0.35:
            kind = "hihat"
        else:
            kind = "snare"
        notes.append(
            {
                "pitch": DRUM_PITCH[kind],
                "start": round(float(librosa.frames_to_time(f, sr=sr, hop_length=hop)), 3),
                "duration": 0.1,
                "velocity": 0.8,
            }
        )
    return notes


def analyze_file(path: Path, work_dir: Path):
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    bpm, beats = detect_bpm(y, sr)
    key = detect_key(y, sr)
    duration = round(float(len(y) / sr), 2)

    job = work_dir.name
    stems, sep_error = separate_stems(path, work_dir)
    tracks = []

    if stems:
        drums_src = stems.get("drums", path)
        tracks.append({"id": "drums", "name": LABELS["drums"], "instrument": "drums", "kind": "drums", "audio": f"/api/stem/{job}/drums" if "drums" in stems else None, "notes": detect_drums(drums_src)})
        for name in STEMS:
            if name == "drums" or name not in stems:
                continue
            notes = transcribe(stems[name])
            if len(notes) >= 8:
                tracks.append({"id": name, "name": LABELS[name], "instrument": name, "kind": "melodic", "audio": f"/api/stem/{job}/{name}", "notes": notes})
    else:
        tracks.append({"id": "drums", "name": LABELS["drums"], "instrument": "drums", "kind": "drums", "audio": None, "notes": detect_drums(path)})
        tracks.append({"id": "mix", "name": LABELS["mix"], "instrument": "mix", "kind": "melodic", "audio": f"/api/audio/{job}", "notes": transcribe(path)})

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
