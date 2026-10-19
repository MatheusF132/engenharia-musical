import { useEffect, useMemo, useRef, useState } from "react";
import { preview } from "./audio";
import type { Note, Track } from "./types";

const ROW = 16;
const KEY_W = 56;
const RULER_H = 24;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);

type Props = {
  track: Track;
  allNotes: Note[];
  bpm: number;
  beats: number[];
  duration: number;
  color: string;
  pps: number;
  position: number;
  follow: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onBegin: () => void;
  onChange: (notes: Note[]) => void;
  onSeek: (t: number) => void;
};

type Drag = { id: string; type: "move" | "resize"; offset: number; lastPitch: number; began: boolean };

export default function PianoRoll({
  track, allNotes, bpm, beats, duration, color, pps, position, follow, selectedId, onSelect, onBegin, onChange, onSeek,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [cursor, setCursor] = useState("crosshair");
  const melodic = track.kind !== "drums";

  const { low, high } = useMemo(() => {
    const ps = allNotes.map((n) => n.pitch);
    const lo = ps.length ? Math.min(...ps) : 48;
    const hi = ps.length ? Math.max(...ps) : 72;
    return { low: Math.max(0, lo - 4), high: Math.min(127, hi + 4) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  const rows = high - low + 1;
  const width = Math.ceil(duration * pps);
  const height = rows * ROW;
  const grid = 60 / bpm / 4;
  const origin = beats[0] ?? 0;
  const snap = (t: number) => origin + Math.round((t - origin) / grid) * grid;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    for (let p = low; p <= high; p++) {
      const y = (high - p) * ROW;
      ctx.fillStyle = BLACK.has(p % 12) ? "#161622" : "#1d1d2b";
      ctx.fillRect(0, y, c.width, ROW);
      ctx.fillStyle = "#2c2c40";
      ctx.fillRect(0, y + ROW - 1, c.width, 1);
    }
    beats.forEach((t, i) => {
      ctx.fillStyle = i % 4 === 0 ? "#55557a" : "#2c2c40";
      ctx.fillRect(Math.round(t * pps), 0, 1, c.height);
    });
    for (const n of track.notes) {
      if (n.pitch < low || n.pitch > high) continue;
      const x = n.start * pps;
      const y = (high - n.pitch) * ROW + 1;
      const w = Math.max(3, n.duration * pps);
      ctx.globalAlpha = 0.5 + 0.5 * n.velocity;
      ctx.fillStyle = n.id === selectedId ? "#ffffff" : color;
      ctx.fillRect(x, y, w, ROW - 2);
      ctx.globalAlpha = 1;
      if (w > 10) {
        ctx.fillStyle = "#00000066";
        ctx.fillRect(x + w - 3, y, 3, ROW - 2);
      }
    }
    ctx.globalAlpha = 1;
  }, [track.notes, selectedId, pps, beats, low, high, width, height, color]);

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

  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = KEY_W + position * pps;
    if (x > el.scrollLeft + el.clientWidth - 60 || x < el.scrollLeft + KEY_W) el.scrollLeft = Math.max(0, position * pps - 80);
  }, [position, follow, pps]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedId || (e.key !== "Delete" && e.key !== "Backspace")) return;
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      onBegin();
      onChange(track.notes.filter((n) => n.id !== selectedId));
      onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const locate = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { t: (e.clientX - r.left) / pps, p: high - Math.floor((e.clientY - r.top) / ROW) };
  };
  const hit = (t: number, p: number) =>
    [...track.notes].reverse().find((n) => n.pitch === p && t >= n.start && t <= n.start + Math.max(n.duration, 4 / pps));
  const inResizeZone = (n: Note, t: number) => n.duration * pps > 10 && t >= n.start + n.duration - Math.min(6 / pps, n.duration / 2);

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const { t, p } = locate(e);
    const n = hit(t, p);
    if (n) {
      const type = inResizeZone(n, t) ? "resize" : "move";
      drag.current = { id: n.id, type, offset: t - n.start, lastPitch: n.pitch, began: false };
      onSelect(n.id);
      setCursor(type === "resize" ? "ew-resize" : "grabbing");
      if (melodic && type === "move") preview(n.pitch);
    } else {
      onBegin();
      const note: Note = { id: crypto.randomUUID(), pitch: p, start: Math.max(0, snap(t)), duration: grid * 4, velocity: 0.8 };
      onChange([...track.notes, note]);
      onSelect(note.id);
      drag.current = { id: note.id, type: "move", offset: 0, lastPitch: p, began: true };
      if (melodic) preview(p);
    }
  };

  const onMove = (e: React.MouseEvent) => {
    const { t, p } = locate(e);
    const d = drag.current;
    if (!d) {
      const n = hit(t, p);
      setCursor(n ? (inResizeZone(n, t) ? "ew-resize" : "grab") : "crosshair");
      return;
    }
    const cur = track.notes.find((n) => n.id === d.id);
    if (!cur) return;
    let next: Note;
    if (d.type === "resize") {
      next = { ...cur, duration: Math.max(grid, snap(t) - cur.start) };
    } else {
      next = { ...cur, start: Math.max(0, snap(t - d.offset)), pitch: Math.min(high, Math.max(low, p)) };
    }
    if (next.start === cur.start && next.pitch === cur.pitch && next.duration === cur.duration) return;
    if (!d.began) {
      onBegin();
      d.began = true;
    }
    if (melodic && next.pitch !== d.lastPitch) {
      preview(next.pitch);
      d.lastPitch = next.pitch;
    }
    onChange(track.notes.map((n) => (n.id === d.id ? next : n)));
  };

  const onUp = () => {
    drag.current = null;
    setCursor("crosshair");
  };

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const { t, p } = locate(e);
    const n = hit(t, p);
    if (!n) return;
    onBegin();
    onChange(track.notes.filter((x) => x.id !== n.id));
    if (selectedId === n.id) onSelect(null);
  };

  const onRuler = (e: React.MouseEvent) => {
    const r = rulerRef.current!.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(duration, (e.clientX - r.left) / pps)));
  };

  return (
    <div className="roll-scroll" ref={scrollRef}>
      <div className="ruler-row">
        <div className="ruler-corner" style={{ width: KEY_W, height: RULER_H }} />
        <div className="ruler-wrap" style={{ width, height: RULER_H }}>
          <canvas ref={rulerRef} width={width} height={RULER_H} style={{ cursor: "pointer" }} onMouseDown={onRuler} title="Clique para mover o ponto de reprodução" />
          <div className="playhead" style={{ left: position * pps }} />
        </div>
      </div>
      <div className="roll-inner" style={{ height }}>
        <div className="keys" style={{ width: KEY_W }}>
          {Array.from({ length: rows }, (_, i) => {
            const p = high - i;
            return (
              <div key={p} className={BLACK.has(p % 12) ? "key black" : "key"} style={{ height: ROW }}>
                {p % 12 === 0 ? `${NAMES[0]}${Math.floor(p / 12) - 1}` : ""}
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
        </div>
      </div>
    </div>
  );
}
