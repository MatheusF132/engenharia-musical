import { useEffect, useMemo, useRef, useState } from "react";
import PianoRoll from "./PianoRoll";
import { INSTRUMENTS, ORIGINAL, TYPE_OPTIONS } from "./instruments";
import { clearCache, getPeaks, getPosition, play, prepareTrack, seek, setTrackVolume, stop } from "./audio";
import type { Edit, Mode, PlayTrack } from "./audio";
import { downloadMidi } from "./midi";
import type { Note, Project, Track } from "./types";

type ApiProject = Omit<Project, "tracks"> & { tracks: (Omit<Track, "notes"> & { notes: Omit<Note, "id">[] })[] };
type Snap = { tracks: Track[]; modes: Record<string, Mode>; dirty: Set<string> };

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const info = (t: Track) => INSTRUMENTS[t.instrument] ?? INSTRUMENTS.other;

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
  const [noteIds, setNoteIds] = useState<string[]>([]);
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [muted, setMuted] = useState<Set<string>>(new Set(["original"]));
  const [solo, setSolo] = useState<string | null>(null);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [sens, setSens] = useState<Record<string, number>>({});
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [starting, setStarting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [pps, setPps] = useState(80);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const pristine = useRef<Record<string, Note[]>>({});
  const undoStack = useRef<Snap[]>([]);
  const redoStack = useRef<Snap[]>([]);
  const raf = useRef(0);

  const minVel = (id: string) => 0.8 * (1 - (sens[id] ?? 100) / 100);
  const shown = (t: Track) => (t.kind === "clips" ? t.notes : t.notes.filter((n) => n.velocity >= minVel(t.id)));
  function editOf(t: Track): Edit {
    const orig = pristine.current[t.id] ?? [];
    const origIds = new Set(orig.map((n) => n.id));
    const cur = new Map(t.notes.map((n) => [n.id, n]));
    const removed: Note[] = [];
    const added: Note[] = [];
    const kept: Note[] = [];
    if (t.kind === "clips") {
      for (const o of orig) {
        const c = cur.get(o.id);
        if (!c) removed.push(o);
        else if (c.start !== o.start || (c.src ?? c.start) !== (o.src ?? o.start)) {
          removed.push(o);
          added.push(c);
        } else {
          const cEnd = c.start + c.duration;
          const oEnd = o.start + o.duration;
          if (cEnd < oEnd - 0.001) removed.push({ ...o, start: cEnd, duration: oEnd - cEnd });
          kept.push(c);
        }
      }
      for (const c of t.notes) if (!origIds.has(c.id)) added.push(c);
      return { removed, added, kept };
    }
    for (const o of orig) {
      const c = cur.get(o.id);
      if (!c) removed.push(o);
      else if (c.start !== o.start || c.pitch !== o.pitch || c.duration !== o.duration) {
        removed.push(o);
        added.push(c);
      } else kept.push(o);
    }
    for (const c of t.notes) if (!origIds.has(c.id)) added.push(c);
    return { removed, added, kept };
  }
  const playTracks = (): PlayTrack[] => (project ? project.tracks.map((t) => ({ ...t, notes: shown(t), edit: editOf(t) })) : []);
  const track = project?.tracks.find((t) => t.id === trackId);

  // ---------- reprodução ----------
  async function startPlayback(from: number | null, quiet = false) {
    if (!project) return;
    if (!quiet) setStarting(true);
    try {
      const ok = await play(playTracks(), modes, muted, solo, project.separated ? project.audio_url : "", volumes, from);
      if (ok) setPlaying(true);
    } catch {
      stop();
      setPlaying(false);
      setError("Não consegui carregar o áudio.");
    } finally {
      setStarting(false);
    }
  }

  function stopAll() {
    stop();
    setPlaying(false);
    setPosition(0);
  }

  async function togglePlay() {
    if (!project || starting) return;
    if (playing) {
      const pos = getPosition();
      stop();
      setPlaying(false);
      setPosition(pos);
      return;
    }
    await startPlayback(position >= project.duration - 0.1 ? 0 : position);
  }

  function handleSeek(t: number) {
    setPosition(t);
    if (playing) void startPlayback(t, true);
    else seek(t);
  }

  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const t = getPosition();
      setPosition(t);
      if (project && t > project.duration) {
        stopAll();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, project]);

  // edições, mudo/solo e sensibilidade valem na hora, mesmo tocando
  useEffect(() => {
    if (!playing) return;
    const id = window.setTimeout(() => void startPlayback(null, true), 350);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.tracks, modes, muted, solo, sens]);

  // ---------- histórico ----------
  const syncHist = () => setHist({ undo: undoStack.current.length, redo: redoStack.current.length });
  const snapshot = (): Snap => ({ tracks: project!.tracks, modes, dirty });

  function begin() {
    if (!project) return;
    undoStack.current.push(snapshot());
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
    syncHist();
  }
  function applySnap(s: Snap) {
    setProject((p) => p && { ...p, tracks: s.tracks });
    setModes(s.modes);
    setDirty(s.dirty);
    setNoteIds([]);
  }
  function undo() {
    const s = undoStack.current.pop();
    if (!s || !project) return;
    redoStack.current.push(snapshot());
    applySnap(s);
    syncHist();
  }
  function redo() {
    const s = redoStack.current.pop();
    if (!s || !project) return;
    undoStack.current.push(snapshot());
    applySnap(s);
    syncHist();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" && (el as HTMLInputElement).type !== "range") return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (e.code === "Space" && el.tagName !== "BUTTON") {
        e.preventDefault();
        void togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------- edição ----------
  function markEdited(id: string) {
    setModes((m) => (m[id] === "notes" ? m : { ...m, [id]: "notes" }));
    setDirty((d) => (d.has(id) ? d : new Set(d).add(id)));
  }

  function updateNotes(visible: Note[]) {
    if (!trackId || !project) return;
    const t = project.tracks.find((x) => x.id === trackId);
    if (!t) return;
    const hidden = t.notes.filter((n) => n.velocity < minVel(t.id));
    setProject((p) => p && { ...p, tracks: p.tracks.map((x) => (x.id === trackId ? { ...x, notes: [...hidden, ...visible] } : x)) });
    setDirty((d) => (d.has(trackId) ? d : new Set(d).add(trackId)));
  }

  function quantize() {
    if (!project || !track) return;
    begin();
    const grid = 60 / project.bpm / 4;
    const origin = project.beats[0] ?? 0;
    const q = (t: number) => Math.max(0, origin + Math.round((t - origin) / grid) * grid);
    setProject((p) => p && { ...p, tracks: p.tracks.map((x) => (x.id === track.id ? { ...x, notes: x.notes.map((n) => ({ ...n, start: q(n.start) })) } : x)) });
    markEdited(track.id);
  }

  function restore(id: string) {
    if (!project) return;
    begin();
    setProject((p) => p && { ...p, tracks: p.tracks.map((x) => (x.id === id ? { ...x, notes: pristine.current[id] } : x)) });
    setDirty((d) => {
      const n = new Set(d);
      n.delete(id);
      return n;
    });
    const t = project.tracks.find((x) => x.id === id);
    if (t?.audio) setModes((m) => ({ ...m, [id]: "audio" }));
  }

  function toggleMute(id: string) {
    setMuted((m) => {
      const next = new Set(m);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function changeVolume(id: string, v: number) {
    setVolumes((all) => ({ ...all, [id]: v }));
    setTrackVolume(id, v);
  }

  // ---------- upload ----------
  async function handleFile(file: File) {
    stopAll();
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
      clearCache();
      pristine.current = Object.fromEntries(p.tracks.map((t) => [t.id, t.notes]));
      undoStack.current = [];
      redoStack.current = [];
      syncHist();
      setModes(Object.fromEntries(p.tracks.map((t) => [t.id, t.audio ? "audio" : "notes"])));
      setDirty(new Set());
      setMuted(new Set(["original"]));
      setSolo(null);
      setVolumes({});
      setSens({});
      setNoteIds([]);
      setProject(p);
      setTrackId(p.tracks[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof TypeError ? "Não consegui falar com o backend. Ele está rodando?" : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (track) void prepareTrack(track, pristine.current[track.id] ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, project?.audio_url]);

  useEffect(() => {
    setPeaks(null);
    if (!track?.audio) return;
    let alive = true;
    getPeaks(track.audio).then((p) => alive && setPeaks(p)).catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, project?.audio_url]);

  function changeType(id: string, instrument: string) {
    setProject((p) => p && { ...p, tracks: p.tracks.map((x) => (x.id === id ? { ...x, instrument } : x)) });
  }

  const trackInfo = track ? info(track) : null;
  const visibleCount = track ? shown(track).length : 0;

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
        {project && (
          <button className="btn" onClick={() => downloadMidi(project.name, project.bpm, playTracks())} title="Baixa todas as faixas como arquivo MIDI">
            Exportar MIDI
          </button>
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
          Sem separação de instrumentos só dá para tocar a música inteira e a transcrição fica bem pior.
          Motivo: {project.separation_error}. Instale o Demucs no mesmo ambiente do backend:{" "}
          <code>pip install -r requirements-demucs.txt</code>
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

      {!loading && project && track && trackInfo && (
        <div className="studio">
          <aside className="tracks">
            {project.tracks.map((t) => {
              const ti = info(t);
              return (
                <div key={t.id} className={t.id === trackId ? "track active" : "track"} style={{ ["--c" as string]: ti.color }}>
                  <div className="track-body">
                    <button className="track-name" onClick={() => { setTrackId(t.id); setNoteIds([]); }}>
                      <span className="track-title"><span className="icon" aria-hidden="true">{ti.icon}</span>{ti.label}</span>
                      <small>{ti.hint} · {shown(t).length} {t.kind === "clips" ? "frases" : "notas"}</small>
                      <span className={modes[t.id] === "audio" ? "badge" : "badge edit"}>
                        {modes[t.id] === "audio" ? (dirty.has(t.id) ? "🔊 Áudio real + edições" : "🔊 Áudio real") : dirty.has(t.id) ? "✏️ Notas editadas" : "🎹 Notas sintetizadas"}
                      </span>
                      <Activity notes={shown(t)} duration={project.duration} color={ti.color} />
                    </button>
                    <label className="vol">
                      Vol
                      <input type="range" min={0} max={100} value={volumes[t.id] ?? 80} onChange={(e) => changeVolume(t.id, Number(e.target.value))} aria-label={`Volume: ${ti.label}`} />
                    </label>
                  </div>
                  <div className="ms">
                    <button className="mini" aria-pressed={muted.has(t.id)} aria-label={`Mudo: ${ti.label}`} title="Mudo" onClick={() => toggleMute(t.id)}>M</button>
                    <button className="mini" aria-pressed={solo === t.id} aria-label={`Solo: ${ti.label}`} title="Solo" onClick={() => setSolo(solo === t.id ? null : t.id)}>S</button>
                  </div>
                </div>
              );
            })}
            {project.separated && (
              <div className="track original" style={{ ["--c" as string]: ORIGINAL.color }}>
                <div className="track-body">
                  <div className="track-name static">
                    <span className="track-title"><span className="icon" aria-hidden="true">{ORIGINAL.icon}</span>{ORIGINAL.label}</span>
                    <small>{ORIGINAL.hint}</small>
                  </div>
                  <label className="vol">
                    Vol
                    <input type="range" min={0} max={100} value={volumes.original ?? 80} onChange={(e) => changeVolume("original", Number(e.target.value))} aria-label="Volume: áudio original" />
                  </label>
                </div>
                <div className="ms">
                  <button className="mini" aria-pressed={muted.has("original")} aria-label="Mudo: áudio original" title="Mudo" onClick={() => toggleMute("original")}>M</button>
                  <button className="mini" aria-pressed={solo === "original"} aria-label="Solo: áudio original" title="Solo" onClick={() => setSolo(solo === "original" ? null : "original")}>S</button>
                </div>
              </div>
            )}
          </aside>

          <main className="editor">
            <div className="toolbar">
              <button className="btn primary" onClick={togglePlay} disabled={starting} title="Espaço">
                {starting ? "Carregando áudio…" : playing ? "❚❚ Pausar" : "▶ Tocar"}
              </button>
              <button className="btn" onClick={() => { handleSeek(0); }} title="Voltar ao início" aria-label="Voltar ao início">⏮</button>
              <span className="time">{fmt(position)} / {fmt(project.duration)}</span>
              <div className="seg" role="group" aria-label="O que tocar nesta faixa">
                <button aria-pressed={modes[track.id] === "audio"} disabled={!track.audio} onClick={() => setModes((m) => ({ ...m, [track.id]: "audio" }))}>Áudio real</button>
                {track.kind !== "clips" && <button aria-pressed={modes[track.id] === "notes"} onClick={() => setModes((m) => ({ ...m, [track.id]: "notes" }))}>Notas</button>}
              </div>
              <button className="btn" onClick={undo} disabled={!hist.undo} title="Ctrl+Z">↶ Desfazer</button>
              <button className="btn" onClick={redo} disabled={!hist.redo} title="Ctrl+Y">↷ Refazer</button>
              {track.kind === "melodic" && <button className="btn" onClick={quantize} title="Alinha as notas à grade (a faixa passa a tocar as notas sintetizadas)">Quantizar</button>}
              {dirty.has(track.id) && <button className="btn" onClick={() => restore(track.id)}>Restaurar original</button>}
            </div>
            <div className="toolbar sub">
              <span className="editor-title">
                <span className="icon" aria-hidden="true">{trackInfo.icon}</span>
                {trackInfo.label}
              </span>
              {track.kind === "melodic" && (
                <label className="zoom" title="Estimado pela análise: troque se o nome estiver errado">
                  Tipo
                  <select value={track.instrument} onChange={(e) => changeType(track.id, e.target.value)} className="type-select">
                    {[...new Set([track.instrument, ...TYPE_OPTIONS])].map((k) => (
                      <option key={k} value={k}>{INSTRUMENTS[k]?.label ?? k}</option>
                    ))}
                  </select>
                </label>
              )}
              {track.kind !== "clips" && (
              <label className="zoom" title="Esconde as notas mais fracas sem apagar">
                Sensibilidade
                <input type="range" min={0} max={100} value={sens[track.id] ?? 100} onChange={(e) => setSens((s) => ({ ...s, [track.id]: Number(e.target.value) }))} />
                <span className="count">{visibleCount} de {track.notes.length} notas</span>
              </label>
              )}
              <label className="zoom">
                Zoom
                <input type="range" min={20} max={100} value={pps} onChange={(e) => setPps(Number(e.target.value))} />
              </label>
            </div>
            <div className="hint-bar">
              {track.kind === "clips"
                ? "Cada bloco é uma frase · arraste move · puxe as bordas para cortar · Ctrl+D duplica · botão direito ou Delete remove a frase do áudio"
                : "Clique cria · arraste move · puxe a borda direita para alongar · Shift+arrastar seleciona várias · Ctrl+D duplica · botão direito ou Delete remove do áudio"}
            </div>
            <PianoRoll
              color={trackInfo.color}
              track={{ ...track, notes: shown(track) }}
              allNotes={track.notes}
              peaks={peaks}
              bpm={project.bpm}
              beats={project.beats}
              duration={project.duration}
              pps={pps}
              position={position}
              follow={playing}
              selectedIds={noteIds}
              onSelect={setNoteIds}
              onBegin={begin}
              onChange={updateNotes}
              onSeek={handleSeek}
            />
          </main>
        </div>
      )}
    </div>
  );
}
