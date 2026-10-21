import * as Tone from "tone";
import type { Note, Track } from "./types";

export type Mode = "audio" | "notes";
export type Edit = { removed: Note[]; added: Note[]; kept: Note[] };
export type PlayTrack = Track & { edit: Edit };

type Iv = [number, number];
type P = { value: any; rampTo: (v: any, r: any, t?: any) => unknown };

let parts: Tone.Part<any>[] = [];
let nodes: Tone.ToneAudioNode[] = [];
const vols = new Map<string, Tone.Volume>();
const cache = new Map<string, Tone.ToneAudioBuffer>();
const peaksCache = new Map<string, Float32Array>();
const banks = new Map<string, Record<string, AudioBuffer>>();
const previewers = new Map<string, Tone.Sampler>();
let token = 0;
let pv: Tone.PolySynth | null = null;

const WAVE: Record<string, "sine" | "triangle" | "square" | "sawtooth"> = {
  bass808: "sine", bass: "sawtooth", lead: "sawtooth", pad: "triangle", keys: "triangle", piano: "triangle",
  pluck: "square", bell: "sine", strings: "sawtooth", guitar: "square", fx: "sawtooth", other: "triangle", mix: "triangle",
};

/** Slider 0..100 (80 = 0 dB) para decibéis. */
export const toDb = (v: number) => (v <= 0 ? -60 : Math.max(-60, 20 * Math.log10(v / 80)));

export function setTrackVolume(id: string, v: number) {
  vols.get(id)?.volume.rampTo(toDb(v), 0.05);
}

export function seek(t: number) {
  Tone.Transport.seconds = t;
}

export function getPosition() {
  return Tone.Transport.seconds;
}

async function load(url: string) {
  let buf = cache.get(url);
  if (!buf) {
    buf = await Tone.ToneAudioBuffer.fromUrl(url);
    cache.set(url, buf);
  }
  return buf;
}

/** Forma de onda (100 pontos por segundo, 0..1) para conferir o que cada bloco representa. */
export async function getPeaks(url: string): Promise<Float32Array> {
  const hit = peaksCache.get(url);
  if (hit) return hit;
  const buf = (await load(url)).get() as AudioBuffer;
  const per = Math.max(1, Math.floor(buf.sampleRate / 100));
  const n = Math.ceil(buf.length / per);
  const out = new Float32Array(n);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const end = Math.min(buf.length, (i + 1) * per);
      for (let j = i * per; j < end; j++) {
        const v = Math.abs(d[j]);
        if (v > m) m = v;
      }
      if (m > out[i]) out[i] = m;
    }
  }
  const sorted = Float32Array.from(out).sort();
  const ref = sorted[Math.floor(sorted.length * 0.99)] || 1;
  for (let i = 0; i < n; i++) out[i] = Math.min(1, out[i] / ref);
  peaksCache.set(url, out);
  return out;
}

// ---------- amostras extraídas da própria música ----------

function sliceBuffer(buf: AudioBuffer, start: number, len: number): AudioBuffer {
  const sr = buf.sampleRate;
  const from = Math.max(0, Math.floor(start * sr));
  const n = Math.max(1, Math.min(buf.length - from, Math.floor(len * sr)));
  const out = Tone.getContext().createBuffer(buf.numberOfChannels, n, sr);
  const fi = Math.floor(0.004 * sr);
  const fo = Math.floor(0.04 * sr);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let g = 1;
      if (i < fi) g = i / fi;
      else if (i > n - fo) g = (n - i) / fo;
      dst[i] = src[from + i] * g;
    }
  }
  return out;
}

function melodicBank(buf: AudioBuffer, notes: Note[]) {
  const overlaps = (n: Note) =>
    notes.reduce((c, m) => (m !== n && m.start < n.start + n.duration && m.start + m.duration > n.start ? c + 1 : c), 0);
  const best = new Map<number, { n: Note; s: number }>();
  for (const n of notes) {
    if (n.duration < 0.12) continue;
    const sc = n.velocity * Math.min(n.duration, 1.2) - 0.35 * overlaps(n);
    const b = Math.floor(n.pitch / 4);
    const cur = best.get(b);
    if (!cur || sc > cur.s) best.set(b, { n, s: sc });
  }
  const urls: Record<string, AudioBuffer> = {};
  for (const { n } of best.values()) {
    urls[Tone.Frequency(n.pitch, "midi").toNote()] = sliceBuffer(buf, n.start - 0.005, Math.min(n.duration + 0.2, 2.5));
  }
  return urls;
}

function drumBank(buf: AudioBuffer, notes: Note[]) {
  const urls: Record<string, AudioBuffer> = {};
  const spec: [number, number][] = [[36, 0.6], [38, 0.4], [42, 0.2]];
  for (const [pitch, len] of spec) {
    let best: Note | null = null;
    let bestScore = -Infinity;
    for (const h of notes.filter((n) => n.pitch === pitch)) {
      const others = notes.filter((o) => o !== h && Math.abs(o.start - h.start) < 0.1).length;
      const sc = h.velocity - 0.5 * others;
      if (sc > bestScore) {
        best = h;
        bestScore = sc;
      }
    }
    if (best) urls[Tone.Frequency(pitch, "midi").toNote()] = sliceBuffer(buf, best.start - 0.005, len);
  }
  return urls;
}

export async function prepareTrack(t: { id: string; audio: string | null; kind: string }, notes: Note[]) {
  if (!t.audio || t.kind === "clips" || banks.has(t.id) || notes.length === 0) return;
  const buf = (await load(t.audio)).get() as AudioBuffer | undefined;
  if (!buf) return;
  const urls = t.kind === "drums" ? drumBank(buf, notes) : melodicBank(buf, notes);
  if (Object.keys(urls).length) banks.set(t.id, urls);
}

export function preview(trackId: string, pitch: number, drums: boolean) {
  if (Tone.getContext().state !== "running") {
    void Tone.start();
    return;
  }
  const bank = banks.get(trackId);
  if (bank) {
    let s = previewers.get(trackId);
    if (!s) {
      s = new Tone.Sampler({ urls: bank, release: 0.25 }).toDestination();
      previewers.set(trackId, s);
    }
    const note = Tone.Frequency(pitch, "midi").toNote();
    if (drums) s.triggerAttackRelease(note, 0.3);
    else s.triggerAttackRelease(note, 0.5);
    return;
  }
  if (!pv) {
    pv = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "triangle" }, envelope: { attack: 0.005, release: 0.15 } }).toDestination();
    pv.volume.value = -12;
  }
  pv.triggerAttackRelease(Tone.Frequency(pitch, "midi").toFrequency(), 0.2);
}

// ---------- ciclo de vida ----------

function teardown() {
  Tone.Transport.stop();
  Tone.Transport.cancel();
  for (const p of parts) {
    try { p.dispose(); } catch { /* já descartado */ }
  }
  for (const n of nodes) {
    try { n.dispose(); } catch { /* já descartado */ }
  }
  parts = [];
  nodes = [];
  vols.clear();
}

export function stop() {
  token++;
  teardown();
}

export function clearCache() {
  stop();
  previewers.forEach((p) => p.dispose());
  previewers.clear();
  banks.clear();
  peaksCache.clear();
  cache.forEach((b) => b.dispose());
  cache.clear();
}

// ---------- remoção de trechos do áudio original ----------

function mergeIntervals(iv: Iv[]): Iv[] {
  const sorted = [...iv].sort((a, b) => a[0] - b[0]);
  const out: Iv[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function windows(iv: Iv[], from: number, apply: (on: boolean, t: number | null) => void) {
  for (const [s, e] of mergeIntervals(iv)) {
    if (e <= from) continue;
    if (s <= from) apply(true, null);
    else Tone.Transport.schedule((t) => apply(true, t), s);
    Tone.Transport.schedule((t) => apply(false, t), e);
  }
}

const setParam = (p: P, v: number, t: number | null, ramp: number) => (t === null ? void (p.value = v) : void p.rampTo(v, ramp, t));

function cutFilters(track: PlayTrack, from: number): Tone.ToneAudioNode[] {
  const out: Tone.ToneAudioNode[] = [];
  const { removed, kept } = track.edit;
  if (!removed.length) return out;
  const end = (n: Note) => n.start + n.duration;

  const duckNode = (iv: Iv[]) => {
    const g = new Tone.Gain(1);
    windows(iv, from, (on, t) => setParam(g.gain, on ? 0 : 1, t, on ? 0.008 : 0.025));
    out.push(g);
  };

  // frase de vocal: silencia exatamente o trecho removido
  if (track.kind === "clips") {
    duckNode(removed.map((r) => [r.start - 0.005, end(r) + 0.005] as Iv));
    return out;
  }

  if (track.kind === "drums") {
    const iv: Record<string, Iv[]> = { kick: [], snare: [], hat: [] };
    for (const n of removed) {
      const k = n.pitch === 36 ? "kick" : n.pitch === 38 ? "snare" : "hat";
      const tail = k === "hat" ? 0.05 : k === "snare" ? 0.11 : 0.14;
      iv[k].push([n.start - 0.006, n.start + Math.max(tail, Math.min(n.duration, 0.4))]);
    }
    const specs: Record<string, { type: BiquadFilterType; f: number; g: number; q: number }[]> = {
      kick: [{ type: "lowshelf", f: 160, g: -30, q: 1 }],
      snare: [{ type: "peaking", f: 1800, g: -20, q: 0.45 }, { type: "peaking", f: 220, g: -12, q: 1 }],
      hat: [{ type: "highshelf", f: 6500, g: -30, q: 1 }],
    };
    for (const k of Object.keys(iv)) {
      if (!iv[k].length) continue;
      for (const sp of specs[k]) {
        const f = new Tone.Filter({ type: sp.type, frequency: sp.f, Q: sp.q, gain: 0 });
        windows(iv[k], from, (on, t) => setParam(f.gain, on ? sp.g : 0, t, on ? 0.004 : 0.02));
        out.push(f);
      }
    }
    return out;
  }

  const duck: Iv[] = [];
  const byPitch = new Map<number, Iv[]>();
  const mono = track.instrument === "bass" || track.instrument === "bass808";
  const segs = track.segments ?? [];
  for (const r of removed) {
    if (mono) {
      const re = end(r);
      let prevEnd = -Infinity;
      let nextStart = Infinity;
      for (const k of kept) {
        if (end(k) <= r.start + 0.01) prevEnd = Math.max(prevEnd, end(k));
        else if (k.start >= re - 0.01) nextStart = Math.min(nextStart, k.start);
      }
      let lo = r.start - 0.02;
      let hi = re + 0.05;
      if (segs.length) {
        for (const sg of segs) {
          if (sg[0] < re && sg[1] > r.start) {
            lo = Math.min(lo, sg[0]);
            hi = Math.max(hi, sg[1]);
          }
        }
      } else {
        lo = r.start - 0.15;
        hi = re + 0.4;
      }
      lo = Math.max(lo, prevEnd + 0.02);
      hi = Math.min(hi, nextStart - 0.02);
      if (hi > lo) duck.push([lo, hi]);
      continue;
    }
    const overlapped = kept.some((k) => Math.min(end(k), end(r)) - Math.max(k.start, r.start) > 0.04);
    if (overlapped) {
      const list = byPitch.get(r.pitch) ?? [];
      list.push([r.start - 0.01, end(r) + 0.03]);
      byPitch.set(r.pitch, list);
    } else {
      duck.push([r.start - 0.01, end(r) + 0.02]);
    }
  }
  for (const [pitch, iv] of byPitch) {
    const f0 = 440 * 2 ** ((pitch - 69) / 12);
    for (const [k, db] of [[1, -26], [2, -20], [3, -14]] as const) {
      const f = new Tone.Filter({ type: "peaking", frequency: f0 * k, Q: 10, gain: 0 });
      windows(iv, from, (on, t) => setParam(f.gain, on ? db : 0, t, 0.015));
      out.push(f);
    }
  }
  if (duck.length) duckNode(duck);
  return out;
}

// ---------- notas novas e modo "notas" ----------

function synthPart(track: Track, notes: Note[], vol: Tone.Volume) {
  const events = notes.map((n) => [n.start, n] as [number, Note]);
  const bank = banks.get(track.id);
  if (bank) {
    const sampler = new Tone.Sampler({ urls: bank, release: 0.25 }).connect(vol);
    nodes.push(sampler);
    const part = new Tone.Part<any>((time: number, n: Note) => {
      const note = Tone.Frequency(n.pitch, "midi").toNote();
      sampler.triggerAttackRelease(note, Math.max(n.duration, 0.05), time, n.velocity);
    }, events);
    part.start(0);
    parts.push(part);
    return;
  }
  if (track.kind === "drums") {
    const kick = new Tone.MembraneSynth().connect(vol);
    const snare = new Tone.NoiseSynth({ envelope: { attack: 0.001, decay: 0.15, sustain: 0 } }).connect(vol);
    const hat = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.05, release: 0.01 } }).connect(vol);
    hat.volume.value = -22;
    nodes.push(kick, snare, hat);
    const part = new Tone.Part<any>((time: number, n: Note) => {
      if (n.pitch === 36) kick.triggerAttackRelease("C1", "8n", time, n.velocity);
      else if (n.pitch === 38) snare.triggerAttackRelease("16n", time, n.velocity);
      else hat.triggerAttackRelease(250, "32n", time, n.velocity);
    }, events);
    part.start(0);
    parts.push(part);
    return;
  }
  const wave = WAVE[track.instrument] ?? "triangle";
  const synth = new Tone.PolySynth(Tone.Synth, { oscillator: { type: wave }, envelope: { attack: 0.01, release: 0.2 } }).connect(vol);
  synth.volume.value = wave === "sawtooth" || wave === "square" ? -20 : -10;
  nodes.push(synth);
  const part = new Tone.Part<any>((time: number, n: Note) => {
    synth.triggerAttackRelease(Tone.Frequency(n.pitch, "midi").toFrequency(), Math.max(n.duration, 0.05), time, n.velocity);
  }, events);
  part.start(0);
  parts.push(part);
}

/** Frases de vocal copiadas ou movidas: tocam o trecho do áudio original no novo lugar. */
function clipPlayers(clips: Note[], buf: Tone.ToneAudioBuffer, vol: Tone.Volume) {
  for (const c of clips) {
    const p = new Tone.Player(buf).connect(vol);
    p.fadeIn = 0.01;
    p.fadeOut = 0.02;
    p.sync().start(c.start, c.src ?? c.start, c.duration);
    nodes.push(p);
  }
}

export async function play(
  tracks: PlayTrack[],
  modes: Record<string, Mode>,
  muted: Set<string>,
  solo: string | null,
  originalUrl: string,
  volumes: Record<string, number>,
  startAt: number | null
): Promise<boolean> {
  await Tone.start();
  const my = ++token;
  const on = (id: string) => (solo ? solo === id : !muted.has(id));
  const useAudio = (t: Track) => (modes[t.id] === "audio" || t.kind === "clips") && !!t.audio;

  const audible = tracks.filter((t) => on(t.id));
  const urls = new Set(audible.filter(useAudio).map((t) => t.audio as string));
  const playOriginal = !!originalUrl && on("original");
  if (playOriginal) urls.add(originalUrl);
  const buffers = new Map<string, Tone.ToneAudioBuffer>();
  await Promise.all([
    ...[...urls].map(async (u) => buffers.set(u, await load(u))),
    ...audible
      .filter((t) => !useAudio(t) || (t.kind !== "clips" && t.edit.added.length > 0))
      .map((t) => prepareTrack(t, [...t.edit.kept, ...t.edit.removed])),
  ]);
  if (my !== token) return false;

  // a troca do grafo é síncrona: não há "buraco" nem volta no tempo ao editar durante a reprodução
  const from = startAt ?? (Tone.Transport.state === "started" ? Tone.Transport.seconds : 0);
  teardown();

  const volFor = (id: string) => {
    const v = new Tone.Volume(toDb(volumes[id] ?? 80)).toDestination();
    vols.set(id, v);
    nodes.push(v);
    return v;
  };

  for (const t of audible) {
    const vol = volFor(t.id);
    if (useAudio(t)) {
      const buf = buffers.get(t.audio as string)!;
      const player = new Tone.Player(buf);
      const cuts = cutFilters(t, from);
      player.chain(...cuts, vol);
      player.sync().start(0);
      nodes.push(player, ...cuts);
      if (t.kind === "clips") clipPlayers(t.edit.added, buf, vol);
      else if (t.edit.added.length) synthPart(t, t.edit.added, vol);
    } else {
      synthPart(t, t.notes, vol);
    }
  }
  if (playOriginal) {
    const player = new Tone.Player(buffers.get(originalUrl)!).connect(volFor("original"));
    player.sync().start(0);
    nodes.push(player);
  }

  Tone.Transport.seconds = from;
  Tone.Transport.start();
  return true;
}
