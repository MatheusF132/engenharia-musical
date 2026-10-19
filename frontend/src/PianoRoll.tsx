import { useEffect, useMemo, useRef, useState } from "react";
import { preview } from "./audio";
import type { Note, Track } from "./types";

const KEY_W = 64;
const RULER_H = 24;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);
const DRUM_LANES = [42, 38, 36];
const DRUM_LABELS: Record<number, string> = { 42: "Hi-hat", 38: "Snare", 36: "Kick" };

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
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onBegin: () => void;
  onChange: (notes: Note[]) => void;
  onSeek: (t: number) => void;
};

type Group = { id: string; start: number; row: number };
type Drag = { type: "move" | "resize"; anchor: string; offset: number; startRow: number; group: Group[]; began: boolean; lastPitch: number };
type Rect = { x0: number; y0: number; x1: number; y1: number };

export default function PianoRoll({
  track, allNotes, bpm, beats, duration, color, pps, position, follow, selectedIds, onSelect, onBegin, onChange, onSeek,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const marqRef = useRef<Rect | null>(null);
  const [marq, setMarq] = useState<Rect | null>(null);
  const [cursor, setCursor] = useState("crosshair");
  const drums = track.kind === "drums";
  const selSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const { low, high } = useMemo(() => {
    const ps = allNotes.map((n) => n.pitch);
    const lo = ps.length ? Math.min(...ps) : 48;
    const hi = ps.length ? Math.max(...ps) : 72;
    return { low: Math.max(0, lo - 4), high: Math.min(127, hi + 4) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  const rowH = drums ? 44 : 16;
  const rows = drums ? DRUM_LANES.length : high - low + 1;
  const clampRow = (r: number) => Math.min(rows - 1, Math.max(0, r));
  const pitchToRow = (p: number) => (drums ? DRUM_LANES.indexOf(p) : high - p);
  const rowToPitch = (r: number) => (drums ? DRUM_LANES[clampRow(r)] : high - clampRow(r));

  const width = Math.ceil(duration * pps);
  const height = rows * rowH;
  const grid = 60 / bpm / 4;
  const origin = beats[0] ?? 0;
  const snap = (t: number) => origin + Math.round((t - origin) / grid) * grid;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    for (let i = 0; i < rows; i++) {
      const y = i * rowH;
      ctx.fillStyle = drums ? (i % 2 ? "#1d1d2b" : "#181824") : BLACK.has(rowToPitch(i) % 12) ? "#161622" : "#1d1d2b";
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
      const x = n.start * pps;
      const y = row * rowH + (drums ? 6 : 1);
      const w = Math.max(drums ? 6 : 3, n.duration * pps);
      ctx.globalAlpha = 0.5 + 0.5 * n.velocity;
      ctx.fillStyle = selSet.has(n.id) ? "#ffffff" : color;
      ctx.fillRect(x, y, w, rowH - (drums ? 12 : 2));
      ctx.globalAlpha = 1;
      if (!drums && w > 10) {
        ctx.fillStyle = "#00000066";
        ctx.fillRect(x + w - 3, y, 3, rowH - 2);
      }
    }
    ctx.globalAlpha = 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.notes, selSet, pps, beats, low, high, width, height, color, drums]);

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
      if (!selectedIds.length || (e.key !== "Delete" && e.key !== "Backspace")) return;
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      onBegin();
      onChange(track.notes.filter((n) => !selSet.has(n.id)));
      onSelect([]);
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
    [...track.notes].reverse().find((n) => pitchToRow(n.pitch) === r && t >= n.start && t <= n.start + Math.max(n.duration, 6 / pps));
  const inResizeZone = (n: Note, t: number) => !drums && n.duration * pps > 10 && t >= n.start + n.duration - Math.min(6 / pps, n.duration / 2);
  const ping = (pitch: number) => preview(track.id, pitch, drums);

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
      const members = multi ? track.notes.filter((x) => selSet.has(x.id)) : [n];
      if (!multi) onSelect([n.id]);
      const type = !multi && inResizeZone(n, L.t) ? "resize" : "move";
      drag.current = {
        type, anchor: n.id, offset: L.t - n.start, startRow: pitchToRow(n.pitch),
        group: members.map((m) => ({ id: m.id, start: m.start, row: pitchToRow(m.pitch) })),
        began: false, lastPitch: n.pitch,
      };
      setCursor(type === "resize" ? "ew-resize" : "grabbing");
      if (type === "move") ping(n.pitch);
    } else {
      onBegin();
      const pitch = rowToPitch(L.r);
      const note: Note = { id: crypto.randomUUID(), pitch, start: Math.max(0, snap(L.t)), duration: drums ? 0.1 : grid * 4, velocity: 0.8 };
      onChange([...track.notes, note]);
      onSelect([note.id]);
      drag.current = { type: "move", anchor: note.id, offset: 0, startRow: clampRow(L.r), group: [{ id: note.id, start: note.start, row: clampRow(L.r) }], began: true, lastPitch: pitch };
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
      setCursor(n ? (inResizeZone(n, L.t) ? "ew-resize" : "grab") : "crosshair");
      return;
    }
    const anchor = track.notes.find((n) => n.id === d.anchor);
    if (!anchor) return;

    let updated: Note[];
    let anchorNext: Note;
    if (d.type === "resize") {
      anchorNext = { ...anchor, duration: Math.max(grid, snap(L.t) - anchor.start) };
      updated = track.notes.map((n) => (n.id === d.anchor ? anchorNext : n));
    } else {
      const g0 = d.group.find((g) => g.id === d.anchor)!;
      const dt = Math.max(0, snap(L.t - d.offset)) - g0.start;
      const dRow = L.r - d.startRow;
      const map = new Map(d.group.map((g) => [g.id, g]));
      updated = track.notes.map((n) => {
        const g = map.get(n.id);
        if (!g) return n;
        return { ...n, start: Math.max(0, g.start + dt), pitch: rowToPitch(g.row + dRow) };
      });
      anchorNext = updated.find((n) => n.id === d.anchor)!;
    }
    if (anchorNext.start === anchor.start && anchorNext.pitch === anchor.pitch && anchorNext.duration === anchor.duration) return;
    if (!d.began) {
      onBegin();
      d.began = true;
    }
    if (anchorNext.pitch !== d.lastPitch) {
      ping(anchorNext.pitch);
      d.lastPitch = anchorNext.pitch;
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
    setCursor("crosshair");
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
            const p = rowToPitch(i);
            const black = !drums && BLACK.has(p % 12);
            return (
              <div key={i} className={black ? "key black" : "key"} style={{ height: rowH, lineHeight: `${rowH}px` }}>
                {drums ? DRUM_LABELS[p] : p % 12 === 0 ? `${NAMES[0]}${Math.floor(p / 12) - 1}` : ""}
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
