import { useEffect, useMemo, useRef, useState } from "react";
import { INSTRUMENTS, ORIGINAL } from "./instruments";
import PianoRoll from "./PianoRoll";
import { getPosition, play, stop } from "./audio";
import type { Note, Project } from "./types";

type ApiProject = Omit<Project, "tracks"> & {
  tracks: { id: string; name: string; instrument: string; kind: "melodic" | "drums"; notes: Omit<Note, "id">[] }[];
};

function Activity({ notes, duration, color }: { notes: Note[]; duration: number; color: string }) {
  const bins = 48;
  const counts = useMemo(() => {
    const c = new Array(bins).fill(0);
    for (const n of notes) c[Math.min(bins - 1, Math.floor((n.start / Math.max(duration, 1)) * bins))]++;
    return c;
  }, [notes, duration]);
  const max = Math.max(1, ...counts);
  return (
    <svg className="activity" viewBox={`0 0 ${bins} 10`} preserveAspectRatio="none" aria-hidden="true">
      {counts.map((c, i) => (
        <rect key={i} x={i} y={10 - (c / max) * 10} width={0.8} height={(c / max) * 10} fill={color} />
      ))}
    </svg>
  );
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [muted, setMuted] = useState<Set<string>>(new Set(["original"]));
  const [solo, setSolo] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [pps, setPps] = useState(80);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const raf = useRef(0);

  function handleStop() {
    stop();
    setPlaying(false);
    setPosition(0);
  }

  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const t = getPosition();
      setPosition(t);
      if (project && t > project.duration) {
        handleStop();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, project]);

  async function handleFile(file: File) {
    handleStop();
    setLoading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/analyze", { method: "POST", body });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.detail ?? "Falha na análise.");
      }
      const data: ApiProject = await res.json();
      const p: Project = {
        ...data,
        tracks: data.tracks.map((t) => ({ ...t, notes: t.notes.map((n) => ({ ...n, id: crypto.randomUUID() })) })),
      };
      setProject(p);
      setTrackId(p.tracks[0]?.id ?? null);
      setMuted(new Set(["original"]));
      setSolo(null);
      setNoteId(null);
    } catch (e) {
      setError(e instanceof TypeError ? "Não consegui falar com o backend. Ele está rodando?" : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function updateNotes(notes: Note[]) {
    setProject((p) => p && { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, notes } : t)) });
  }

  function toggleMute(id: string) {
    setMuted((m) => {
      const next = new Set(m);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function togglePlay() {
    if (!project) return;
    if (playing) return handleStop();
    try {
      await play(project.tracks, muted, solo, project.audio_url);
      setPlaying(true);
    } catch {
      handleStop();
      setError("Não consegui carregar o áudio original.");
    }
  }

  const track = project?.tracks.find((t) => t.id === trackId);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Engenharia Musical</h1>
        {project && (
          <div className="chips">
            <span className="chip">{project.name}</span>
            <span className="chip">{project.bpm} BPM</span>
            <span className="chip">Tom: {project.key}</span>
          </div>
        )}
        <label className={loading ? "btn disabled" : "btn primary"}>
          {project ? "Trocar música" : "Enviar música"}
          <input
            type="file"
            accept="audio/*"
            hidden
            disabled={loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
        </label>
      </header>

      {error && <div className="error" role="alert">{error}</div>}

      {project && !project.separated && !loading && (
        <div className="error" role="alert">
          Os instrumentos não foram separados, então a transcrição fica bem pior.
          Motivo: {project.separation_error}. Instale com <code>pip install -r requirements-demucs.txt</code>.
        </div>
      )}

      {loading && (
        <div className="empty" role="status">
          <p>Analisando a música… isso pode levar alguns minutos.</p>
        </div>
      )}

      {!loading && !project && (
        <div className="empty">
          <p>Envie uma música (mp3, wav, flac, ogg ou m4a) para começar a engenharia reversa.</p>
        </div>
      )}

      {!loading && project && track && (
        <div className="studio">
          <aside className="tracks">
            {project.tracks.map((t) => {
              const info = INSTRUMENTS[t.instrument] ?? INSTRUMENTS.other;
              return (
                <div key={t.id} className={t.id === trackId ? "track active" : "track"} style={{ ["--c" as string]: info.color }}>
                  <button className="track-name" onClick={() => { setTrackId(t.id); setNoteId(null); }}>
                    <span className="track-title"><span className="icon" aria-hidden="true">{info.icon}</span>{info.label}</span>
                    <small>{info.hint} · {t.notes.length} notas</small>
                    <Activity notes={t.notes} duration={project.duration} color={info.color} />
                  </button>
                  <div className="ms">
                    <button className="mini" aria-pressed={muted.has(t.id)} aria-label={`Mudo: ${info.label}`} title="Mudo" onClick={() => toggleMute(t.id)}>M</button>
                    <button className="mini" aria-pressed={solo === t.id} aria-label={`Solo: ${info.label}`} title="Solo" onClick={() => setSolo(solo === t.id ? null : t.id)}>S</button>
                  </div>
                </div>
              );
            })}
            <div className="track original" style={{ ["--c" as string]: ORIGINAL.color }}>
              <div className="track-name static">
                <span className="track-title"><span className="icon" aria-hidden="true">{ORIGINAL.icon}</span>{ORIGINAL.label}</span>
                <small>{ORIGINAL.hint}</small>
              </div>
              <div className="ms">
                <button className="mini" aria-pressed={muted.has("original")} aria-label="Mudo: áudio original" title="Mudo" onClick={() => toggleMute("original")}>M</button>
                <button className="mini" aria-pressed={solo === "original"} aria-label="Solo: áudio original" title="Solo" onClick={() => setSolo(solo === "original" ? null : "original")}>S</button>
              </div>
            </div>
          </aside>

          <main className="editor">
            <div className="toolbar">
              <button className="btn primary" onClick={togglePlay}>
                {playing ? "■ Parar" : "▶ Tocar"}
              </button>
              <label className="zoom">
                Zoom
                <input type="range" min={20} max={100} value={pps} onChange={(e) => setPps(Number(e.target.value))} />
              </label>
              <span className="hint">Clique para criar nota · arraste para mover · Delete apaga</span>
            </div>
            <div className="editor-title">
              <span className="icon" aria-hidden="true">{(INSTRUMENTS[track.instrument] ?? INSTRUMENTS.other).icon}</span>
              {(INSTRUMENTS[track.instrument] ?? INSTRUMENTS.other).label}
            </div>
            <PianoRoll
              color={(INSTRUMENTS[track.instrument] ?? INSTRUMENTS.other).color}
              track={track}
              bpm={project.bpm}
              beats={project.beats}
              duration={project.duration}
              pps={pps}
              position={position}
              selectedId={noteId}
              onSelect={setNoteId}
              onChange={updateNotes}
            />
          </main>
        </div>
      )}
    </div>
  );
}
