import type { Track } from "./types";

const PPQ = 480;
const enc = new TextEncoder();

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (tag: string, data: number[]) => [...enc.encode(tag), ...u32(data.length), ...data];
const meta = (type: number, bytes: number[]) => [0x00, 0xff, type, ...vlq(bytes.length), ...bytes];
const END = [0x00, 0xff, 0x2f, 0x00];

export function buildMidi(bpm: number, tracks: Track[]): Uint8Array {
  const tps = (bpm / 60) * PPQ;
  const us = Math.round(60_000_000 / bpm);
  const out: number[] = chunk("MThd", [0, 1, ((tracks.length + 1) >> 8) & 255, (tracks.length + 1) & 255, PPQ >> 8, PPQ & 255]);
  out.push(...chunk("MTrk", [...meta(0x03, [...enc.encode("Tempo")]), ...meta(0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255]), ...END]));

  let melodic = 0;
  for (const t of tracks) {
    const ch = t.kind === "drums" ? 9 : melodic++ % 9;
    const evs: { tick: number; order: number; bytes: number[] }[] = [];
    for (const n of t.notes) {
      const on = Math.round(n.start * tps);
      const off = Math.max(on + 1, Math.round((n.start + n.duration) * tps));
      const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
      evs.push({ tick: on, order: 1, bytes: [0x90 | ch, n.pitch, vel] }, { tick: off, order: 0, bytes: [0x80 | ch, n.pitch, 0] });
    }
    evs.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const data: number[] = [...meta(0x03, [...enc.encode(t.name)])];
    let prev = 0;
    for (const e of evs) {
      data.push(...vlq(e.tick - prev), ...e.bytes);
      prev = e.tick;
    }
    data.push(...END);
    out.push(...chunk("MTrk", data));
  }
  return new Uint8Array(out);
}

export function downloadMidi(name: string, bpm: number, tracks: Track[]) {
  const blob = new Blob([buildMidi(bpm, tracks).buffer as ArrayBuffer], { type: "audio/midi" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.mid`;
  a.click();
  URL.revokeObjectURL(a.href);
}
