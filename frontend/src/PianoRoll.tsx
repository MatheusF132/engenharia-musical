import { useEffect, useMemo, useRef, useState } from "react";
import { preview } from "./audio";
import type { Note, Track } from "./types";

const KEY_W = 64;
const RULER_H = 24;
const WAVE_H = 44;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);
const DRUM_LANES = [42, 38, 36];
const DRUM_LABELS: Record<number, string> = { 42: "Hi-hat", 38: "Snare", 36: "Kick" };
const DRUM_DUR: Record<number, number> = { 42: 0.06, 38: 0.15, 36: 0.2 };

type Props = {
  track: Track;
  allNotes: Note[];
  peaks: Float32Array | null;
  bpm: number;
  beats: number[];
  duration: number;
  color: string;
  pps: number;
  position: number;
  follow: boolean;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onBegin: () => void;
  onChange: (notes: Note[]) => void;
  onSeek: (t: number) => void;
};

type Group = { id: string; start: number; row: number };
type DragType = "move" | "right" | "left";
type Drag = { type: DragType; anchor: string; init: Note; offset: number; startRow: number; group: Group[]; began: boolean; lastPitch: number };
type Rect = { x0: number; y0: number; x1: number; y1: number };

function peakAt(pk: Float32Array, t: number, span: number) {
  const i0 = Math.max(0, Math.floor(t * 100));
  const i1 = Math.max(i0 + 1, Math.floor((t + span) * 100));
  let m = 0;
  for (let i = i0; i < i1 && i < pk.length; i++) if (pk[i] > m) m = pk[i];
  return Math.sqrt(m);
}

export default function PianoRoll({
  track, allNotes, peaks, bpm, beats, duration, color, pps, position, follow, selectedIds, onSelect, onBegin, onChange, onSeek,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const marqRef = useRef<Rect | null>(null);
  const [marq, setMarq] = useState<Rect | null>(null);
  const [cursor, setCursor] = useState("crosshair");
  const drums = track.kind === "drums";
  const clips = track.kind === "clips";
  const selSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const { low, high } = useMemo(() => {
    const ps = allNotes.map((n) => n.pitch);
    const lo = ps.length ? Math.min(...ps) : 48;
    const hi = ps.length ? Math.max(...ps) : 72;
    return { low: Math.max(0, lo - 4), high: Math.min(127, hi + 4) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  const rowH = drums ? 44 : clips ? 88 : 16;
  const rows = drums ? DRUM_LANES.length : clips ? 1 : high - low + 1;
  const clampRow = (r: number) => Math.min(rows - 1, Math.max(0, r));
  const pitchToRow = (p: number) => (drums ? DRUM_LANES.indexOf(p) : clips ? 0 : high - p);
  const rowToPitch = (r: number) => (drums ? DRUM_LANES[clampRow(r)] : clips ? 60 : high - clampRow(r));

  const width = Math.ceil(duration * pps);
  const height = rows * rowH;
  const grid = 60 / bpm / 4;
  const origin = beats[0] ?? 0;
  const snapT = (t: number) => (clips ? Math.round(t * 100) / 100 : origin + Math.round((t - origin) / grid) * grid);
  const minDur = clips ? 0.1 : drums ? 0.03 : grid;

  // ----- grade de notas / frases -----
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    for (let i = 0; i < rows; i++) {
      const y = i * rowH;
      ctx.fillStyle = drums || clips ? (i % 2 ? "#1d1d2b" : "#181824") : BLACK.has(rowToPitch(i) % 12) ? "#161622" : "#1d1d2b";
      ctx.fillRect(0, y, c.width, rowH);
      ctx.fillStyle = "#2c2c40";
      ctx.fillRect(0, y + rowH - 1, c.width, 1);
    }
    beats.forEach((t, i) => {
      ctx.fillStyle = i % 4 === 0 ? "#55557a" : "#2c2c40";
      ctx.fillRect(Math.round(t * pps), 0, 1, c.height);
    });

    for (const n of track.notes) {
      const row = pitchToRow(n.pitch);
      if (row < 0 || row >= rows) continue;
      const sel = selSet.has(n.id);
      const x = n.start * pps;
      const w = Math.max(clips ? 4 : drums ? 8 : 3, n.duration * pps);

      if (clips) {
        ctx.fillStyle = sel ? "#ffffff30" : color + "33";
        ctx.fillRect(x, 4, w, rowH - 8);
        if (peaks) {
          const src = n.src ?? n.start;
          ctx.fillStyle = sel ? "#ffffff" : color;
          const mid = rowH / 2;
          for (let px = 0; px < w; px++) {
            const h = peakAt(peaks, src + px / pps, 1 / pps) * (rowH - 20);
            ctx.fillRect(x + px, mid - h / 2, 1, Math.max(1, h));
          }
        }
        ctx.strokeStyle = sel ? "#ffffff" : color;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, 5, w - 2, rowH - 10);
        ctx.fillStyle = sel ? "#ffffff" : color;
        ctx.fillRect(x, 4, 4, rowH - 8);
        ctx.fillRect(x + w - 4, 4, 4, rowH - 8);
        continue;
      }

      const y = row * rowH + (drums ? 6 : 1);
      const h = rowH - (drums ? 12 : 2);
      ctx.globalAlpha = 0.5 + 0.5 * n.velocity;
      ctx.fillStyle = sel ? "#ffffff" : color;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      if (w > 12) {
        ctx.fillStyle = "#00000077";
        ctx.fillRect(x + w - 4, y, 4, h);
      }
    }
    ctx.globalAlpha = 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.notes, selSet, pps, beats, low, high, width, height, color, drums, clips, peaks]);

  // ----- régua -----
  useEffect(() => {
    const c = rulerRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#13131c";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.font = "11px system-ui";
    ctx.textBaseline = "top";
    beats.forEach((t, i) => {
      const x = Math.round(t * pps);
      const bar = i % 4 === 0;
      ctx.fillStyle = bar ? "#8a8aad" : "#3a3a55";
      ctx.fillRect(x, bar ? 3 : RULER_H - 8, 1, bar ? RULER_H - 3 : 8);
      if (bar) {
        ctx.fillStyle = "#c8c8e0";
        ctx.fillText(String(i / 4 + 1), x + 4, 4);
      }
    });
  }, [beats, pps, width]);

  // ----- forma de onda do instrumento (para conferir os blocos) -----
  useEffect(() => {
    const c = waveRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#0f0f17";
    ctx.fillRect(0, 0, c.width, c.height);
    if (!peaks) return;
    ctx.fillStyle = color;
    const mid = WAVE_H / 2;
    for (let px = 0; px < c.width; px++) {
      const h = peakAt(peaks, px / pps, 1 / pps) * (WAVE_H - 6);
      ctx.fillRect(px, mid - h / 2, 1, Math.max(1, h));
    }
    ctx.fillStyle = "#ffffff22";
    beats.forEach((t, i) => {
      if (i % 4 === 0) ctx.fillRect(Math.round(t * pps), 0, 1, WAVE_H);
    });
  }, [peaks, pps, width, color, beats]);

  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = KEY_W + position * pps;
    if (x > el.scrollLeft + el.clientWidth - 60 || x < el.scrollLeft + KEY_W) el.scrollLeft = Math.max(0, position * pps - 80);
  }, [position, follow, pps]);

  // ----- teclado: Delete remove, Ctrl+D duplica -----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedIds.length) return;
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        onBegin();
        onChange(track.notes.filter((n) => !selSet.has(n.id)));
        onSelect([]);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        onBegin();
        const copies = track.notes
          .filter((n) => selSet.has(n.id))
          .map((n) => ({ ...n, id: crypto.randomUUID(), src: clips ? n.src ?? n.start : n.src, start: n.start + (clips ? n.duration : grid * 4) }));
        onChange([...track.notes, ...copies]);
        onSelect(copies.map((n) => n.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const locate = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y, t: x / pps, r: Math.floor(y / rowH) };
  };
  const hit = (t: number, r: number) =>
    [...track.notes].reverse().find((n) => pitchToRow(n.pitch) === r && t >= n.start && t <= n.start + Math.max(n.duration, 8 / pps));
  const zoneOf = (n: Note, t: number): DragType => {
    const z = Math.min(8 / pps, n.duration / 3);
    if (t >= n.start + n.duration - z) return "right";
    if (clips && t <= n.start + z) return "left";
    return "move";
  };
  const ping = (pitch: number) => {
    if (!clips) preview(track.id, pitch, drums);
  };

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const L = locate(e);
    if (e.shiftKey) {
      marqRef.current = { x0: L.x, y0: L.y, x1: L.x, y1: L.y };
      setMarq(marqRef.current);
      return;
    }
    const n = hit(L.t, L.r);
    if (n) {
      const multi = selSet.has(n.id) && selectedIds.length > 1;
      const type = multi ? "move" : zoneOf(n, L.t);
      const members = multi ? track.notes.filter((x) => selSet.has(x.id)) : [n];
      if (!multi) onSelect([n.id]);
      drag.current = {
        type, anchor: n.id, init: n, offset: L.t - n.start, startRow: pitchToRow(n.pitch),
        group: members.map((m) => ({ id: m.id, start: m.start, row: pitchToRow(m.pitch) })),
        began: false, lastPitch: n.pitch,
      };
      setCursor(type === "move" ? "grabbing" : "ew-resize");
      if (type === "move") ping(n.pitch);
    } else if (clips) {
      onSelect([]);
    } else {
      onBegin();
      const pitch = rowToPitch(L.r);
      const note: Note = {
        id: crypto.randomUUID(), pitch, start: Math.max(0, snapT(L.t)),
        duration: drums ? DRUM_DUR[pitch] : grid * 4, velocity: 0.8,
      };
      onChange([...track.notes, note]);
      onSelect([note.id]);
      drag.current = {
        type: "move", anchor: note.id, init: note, offset: 0, startRow: clampRow(L.r),
        group: [{ id: note.id, start: note.start, row: clampRow(L.r) }], began: true, lastPitch: pitch,
      };
      ping(pitch);
    }
  };

  const onMove = (e: React.MouseEvent) => {
    const L = locate(e);
    if (marqRef.current) {
      marqRef.current = { ...marqRef.current, x1: L.x, y1: L.y };
      setMarq(marqRef.current);
      return;
    }
    const d = drag.current;
    if (!d) {
      const n = hit(L.t, L.r);
      setCursor(n ? (zoneOf(n, L.t) === "move" ? "grab" : "ew-resize") : clips ? "default" : "crosshair");
      return;
    }
    const anchor = track.notes.find((n) => n.id === d.anchor);
    if (!anchor) return;
    const init = d.init;

    let updated: Note[];
    let next: Note;
    if (d.type === "right") {
      next = { ...anchor, duration: Math.max(minDur, snapT(L.t) - init.start) };
      updated = track.notes.map((n) => (n.id === d.anchor ? next : n));
    } else if (d.type === "left") {
      const end = init.start + init.duration;
      const ns = Math.min(Math.max(0, snapT(L.t)), end - minDur);
      next = { ...anchor, start: ns, src: (init.src ?? init.start) + (ns - init.start), duration: end - ns };
      updated = track.notes.map((n) => (n.id === d.anchor ? next : n));
    } else {
      const g0 = d.group.find((g) => g.id === d.anchor)!;
      const dt = Math.max(0, snapT(L.t - d.offset)) - g0.start;
      const dRow = L.r - d.startRow;
      const map = new Map(d.group.map((g) => [g.id, g]));
      updated = track.notes.map((n) => {
        const g = map.get(n.id);
        if (!g) return n;
        return { ...n, start: Math.max(0, g.start + dt), pitch: rowToPitch(g.row + dRow) };
      });
      next = updated.find((n) => n.id === d.anchor)!;
    }
    if (next.start === anchor.start && next.pitch === anchor.pitch && next.duration === anchor.duration) return;
    if (!d.began) {
      onBegin();
      d.began = true;
    }
    if (next.pitch !== d.lastPitch) {
      ping(next.pitch);
      d.lastPitch = next.pitch;
    }
    onChange(updated);
  };

  const onUp = () => {
    const m = marqRef.current;
    if (m) {
      const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
      const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
      const ids = track.notes
        .filter((n) => {
          const row = pitchToRow(n.pitch);
          if (row < 0) return false;
          const nx0 = n.start * pps;
          const nx1 = nx0 + Math.max(3, n.duration * pps);
          return nx1 >= x0 && nx0 <= x1 && (row + 1) * rowH >= y0 && row * rowH <= y1;
        })
        .map((n) => n.id);
      onSelect(ids);
      marqRef.current = null;
      setMarq(null);
    }
    drag.current = null;
    setCursor(clips ? "default" : "crosshair");
  };

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const L = locate(e);
    const n = hit(L.t, L.r);
    if (!n) return;
    onBegin();
    const doomed = selSet.has(n.id) ? selSet : new Set([n.id]);
    onChange(track.notes.filter((x) => !doomed.has(x.id)));
    onSelect([]);
  };

  const onRuler = (e: React.MouseEvent) => {
    const r = rulerRef.current!.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(duration, (e.clientX - r.left) / pps)));
  };

  return (
    <div className="roll-scroll" ref={scrollRef}>
      <div className="ruler-row" style={{ top: 0 }}>
        <div className="ruler-corner" style={{ width: KEY_W, height: RULER_H }} />
        <div className="ruler-wrap" style={{ width, height: RULER_H }}>
          <canvas ref={rulerRef} width={width} height={RULER_H} style={{ cursor: "pointer" }} onMouseDown={onRuler} title="Clique para mover o ponto de reprodução" />
          <div className="playhead" style={{ left: position * pps }} />
        </div>
      </div>
      {!clips && (
        <div className="ruler-row" style={{ top: RULER_H, zIndex: 3 }}>
          <div className="ruler-corner wave-label" style={{ width: KEY_W, height: WAVE_H }}>Áudio</div>
          <div className="ruler-wrap" style={{ width, height: WAVE_H }}>
            <canvas ref={waveRef} width={width} height={WAVE_H} onMouseDown={onRuler} style={{ cursor: "pointer" }} />
            <div className="playhead" style={{ left: position * pps }} />
          </div>
        </div>
      )}
      <div className="roll-inner" style={{ height }}>
        <div className="keys" style={{ width: KEY_W }}>
          {Array.from({ length: rows }, (_, i) => {
            const p = rowToPitch(i);
            const black = !drums && !clips && BLACK.has(p % 12);
            const label = drums ? DRUM_LABELS[p] : clips ? "Frases" : p % 12 === 0 ? `${NAMES[0]}${Math.floor(p / 12) - 1}` : "";
            return (
              <div key={i} className={black ? "key black" : "key"} style={{ height: rowH, lineHeight: `${rowH}px` }}>
                {label}
              </div>
            );
          })}
        </div>
        <div className="canvas-wrap" style={{ width, height }}>
          <canvas
            ref={canvasRef}
            width={width}
            height={height}
            style={{ cursor }}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={onUp}
            onContextMenu={onContext}
          />
          <div className="playhead" style={{ left: position * pps }} />
          {marq && (
            <div
              className="marquee"
              style={{ left: Math.min(marq.x0, marq.x1), top: Math.min(marq.y0, marq.y1), width: Math.abs(marq.x1 - marq.x0), height: Math.abs(marq.y1 - marq.y0) }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
