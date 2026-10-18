import { useEffect, useRef, useState } from "react";
import PianoRoll from "./PianoRoll";
import { getPosition, play, stop } from "./audio";
import type { Note, Project } from "./types";

type ApiProject = Omit<Project, "tracks"> & {
  tracks: { id: string; name: string; kind: "melodic" | "drums"; notes: Omit<Note, "id">[] }[];
};

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [muted, setMuted] = useState<Set<string>>(new Set());
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
      setMuted(new Set());
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
    await play(project.tracks, muted, solo);
    setPlaying(true);
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
            {!project.separated && <span className="chip warn">Sem separação de instrumentos</span>}
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
            {project.tracks.map((t) => (
              <div key={t.id} className={t.id === trackId ? "track active" : "track"}>
                <button className="track-name" onClick={() => { setTrackId(t.id); setNoteId(null); }}>
                  {t.name}
                  <small>{t.notes.length} notas</small>
                </button>
                <button
                  className="mini"
                  aria-pressed={muted.has(t.id)}
                  title="Mudo"
                  onClick={() => toggleMute(t.id)}
                >
                  M
                </button>
                <button
                  className="mini"
                  aria-pressed={solo === t.id}
                  title="Solo"
                  onClick={() => setSolo(solo === t.id ? null : t.id)}
                >
                  S
                </button>
              </div>
            ))}
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
            <PianoRoll
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
