import { useEffect, useMemo, useRef, useState } from "react";
import type { Note, Track } from "./types";

const ROW = 16;
const KEY_W = 56;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);

type Props = {
  track: Track;
  bpm: number;
  beats: number[];
  duration: number;
  pps: number;
  position: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (notes: Note[]) => void;
};

export default function PianoRoll({ track, bpm, beats, duration, pps, position, selectedId, onSelect, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: string; offset: number } | null>(null);
  const [cursor, setCursor] = useState("crosshair");

  const { low, high } = useMemo(() => {
    const ps = track.notes.map((n) => n.pitch);
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
      ctx.globalAlpha = 0.55 + 0.45 * n.velocity;
      ctx.fillStyle = n.id === selectedId ? "#ffd166" : "#8b6cff";
      ctx.fillRect(n.start * pps, (high - n.pitch) * ROW + 1, Math.max(3, n.duration * pps), ROW - 2);
    }
    ctx.globalAlpha = 1;
  }, [track.notes, selectedId, pps, beats, low, high, width, height]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedId || (e.key !== "Delete" && e.key !== "Backspace")) return;
      onChange(track.notes.filter((n) => n.id !== selectedId));
      onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, track.notes, onChange, onSelect]);

  const locate = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { t: (e.clientX - r.left) / pps, p: high - Math.floor((e.clientY - r.top) / ROW) };
  };
  const hit = (t: number, p: number) =>
    [...track.notes].reverse().find((n) => n.pitch === p && t >= n.start && t <= n.start + Math.max(n.duration, 3 / pps));

  const onDown = (e: React.MouseEvent) => {
    const { t, p } = locate(e);
    const n = hit(t, p);
    if (n) {
      onSelect(n.id);
      drag.current = { id: n.id, offset: t - n.start };
      setCursor("grabbing");
    } else {
      const note: Note = { id: crypto.randomUUID(), pitch: p, start: Math.max(0, snap(t)), duration: grid * 4, velocity: 0.8 };
      onChange([...track.notes, note]);
      onSelect(note.id);
      drag.current = { id: note.id, offset: 0 };
    }
  };

  const onMove = (e: React.MouseEvent) => {
    const { t, p } = locate(e);
    const d = drag.current;
    if (d) {
      onChange(
        track.notes.map((n) =>
          n.id === d.id ? { ...n, start: Math.max(0, snap(t - d.offset)), pitch: Math.min(high, Math.max(low, p)) } : n
        )
      );
    } else {
      setCursor(hit(t, p) ? "grab" : "crosshair");
    }
  };

  const onUp = () => {
    drag.current = null;
    setCursor("crosshair");
  };

  return (
    <div className="roll-scroll">
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
          />
          <div className="playhead" style={{ left: position * pps }} />
        </div>
      </div>
    </div>
  );
}
