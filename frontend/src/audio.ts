import * as Tone from "tone";
import type { Note, Track } from "./types";

export type Edit = { removed: Note[]; added: Note[]; kept: Note[] };
export type PlayTrack = Track & { edit: Edit };

export type Mode = "audio" | "notes";

let parts: Tone.Part<any>[] = [];
let nodes: Tone.ToneAudioNode[] = [];
const vols = new Map<string, Tone.Volume>();
const cache = new Map<string, Tone.ToneAudioBuffer>();
let token = 0;
let pv: Tone.PolySynth | null = null;
const banks = new Map<string, Record<string, AudioBuffer>>();
const previewers = new Map<string, Tone.Sampler>();

const WAVE: Record<string, "sine" | "triangle" | "square" | "sawtooth"> = {
  bass: "sawtooth", vocals: "sine", guitar: "square", piano: "triangle", other: "sawtooth", mix: "triangle",
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

/** Monta o "instrumento" a partir das próprias notas da música: uma amostra por faixa de altura. */
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

/** Kit de bateria extraído da música: a melhor batida limpa de cada tipo. */
function drumBank(buf: AudioBuffer, notes: Note[]) {
  const urls: Record<string, AudioBuffer> = {};
  const spec: [number, number][] = [[36, 0.4], [38, 0.3], [42, 0.15]];
  for (const [pitch, len] of spec) {
    let best: Note | null = null;
    let bestScore = -Infinity;
    for (const h of notes.filter((n) => n.pitch === pitch)) {
      const others = notes.filter((o) => o !== h && Math.abs(o.start - h.start) < 0.08).length;
      const sc = h.velocity - 0.4 * others;
      if (sc > bestScore) {
        best = h;
        bestScore = sc;
      }
    }
    if (best) urls[Tone.Frequency(pitch, "midi").toNote()] = sliceBuffer(buf, best.start - 0.005, len);
  }
  return urls;
}

/** Carrega o áudio do instrumento e extrai dele as amostras usadas para tocar notas novas. */
export async function prepareTrack(t: { id: string; audio: string | null; kind: "melodic" | "drums" }, notes: Note[]) {
  if (!t.audio || banks.has(t.id) || notes.length === 0) return;
  const buf = (await load(t.audio)).get() as AudioBuffer | undefined;
  if (!buf) return;
  const urls = t.kind === "drums" ? drumBank(buf, notes) : melodicBank(buf, notes);
  if (Object.keys(urls).length) banks.set(t.id, urls);
}

/** Toca a nota ao criar ou mover, com o som do próprio instrumento da música. */
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
    if (drums) s.triggerAttack(note);
    else s.triggerAttackRelease(note, 0.5);
    return;
  }
  if (!pv) {
    pv = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "triangle" }, envelope: { attack: 0.005, release: 0.15 } }).toDestination();
    pv.volume.value = -12;
  }
  pv.triggerAttackRelease(Tone.Frequency(pitch, "midi").toFrequency(), 0.2);
}

export function stop() {
  token++;
  Tone.Transport.stop();
  Tone.Transport.cancel();
  parts.forEach((p) => p.dispose());
  nodes.forEach((n) => n.dispose());
  parts = [];
  nodes = [];
  vols.clear();
}

export function clearCache() {
  stop();
  previewers.forEach((p) => p.dispose());
  previewers.clear();
  banks.clear();
  cache.forEach((b) => b.dispose());
  cache.clear();
}

async function load(url: string) {
  let buf = cache.get(url);
  if (!buf) {
    buf = await Tone.ToneAudioBuffer.fromUrl(url);
    cache.set(url, buf);
  }
  return buf;
}

type Iv = [number, number];
type P = { value: any; rampTo: (v: any, r: any, t?: any) => unknown };

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

/** Liga/desliga um efeito em janelas de tempo, respeitando o ponto onde a reprodução começa. */
function windows(iv: Iv[], startAt: number, apply: (on: boolean, t: number | null) => void) {
  for (const [s, e] of mergeIntervals(iv)) {
    if (e <= startAt) continue;
    if (s <= startAt) apply(true, null);
    else Tone.Transport.schedule((t) => apply(true, t), s);
    Tone.Transport.schedule((t) => apply(false, t), e);
  }
}

const setParam = (p: P, v: number, t: number | null) => (t === null ? void (p.value = v) : void p.rampTo(v, 0.015, t));

/**
 * Tira do áudio do instrumento só as notas apagadas ou movidas:
 * - nota sozinha no momento: abaixa o áudio da faixa naquele trecho;
 * - nota junto com outras: filtros que cortam a frequência da nota e seus harmônicos;
 * - bateria: corta só a faixa de frequência daquele tipo de batida.
 */
function cutFilters(track: PlayTrack, startAt: number): Tone.ToneAudioNode[] {
  const out: Tone.ToneAudioNode[] = [];
  const { removed, kept } = track.edit;
  if (!removed.length) return out;
  const end = (n: Note) => n.start + n.duration;

  if (track.kind === "drums") {
    const iv: Record<string, Iv[]> = { kick: [], snare: [], hat: [] };
    for (const n of removed) {
      const k = n.pitch === 36 ? "kick" : n.pitch === 38 ? "snare" : "hat";
      iv[k].push([n.start - 0.01, n.start + (k === "hat" ? 0.06 : 0.12)]);
    }
    const specs: Record<string, { type: BiquadFilterType; f: number; g: number; q: number }[]> = {
      kick: [{ type: "lowshelf", f: 150, g: -24, q: 1 }],
      snare: [{ type: "peaking", f: 1000, g: -18, q: 0.5 }, { type: "peaking", f: 200, g: -12, q: 1 }],
      hat: [{ type: "highshelf", f: 6000, g: -24, q: 1 }],
    };
    for (const k of Object.keys(iv)) {
      if (!iv[k].length) continue;
      for (const sp of specs[k]) {
        const f = new Tone.Filter({ type: sp.type, frequency: sp.f, Q: sp.q, gain: 0 });
        windows(iv[k], startAt, (on, t) => setParam(f.gain, on ? sp.g : 0, t));
        out.push(f);
      }
    }
    return out;
  }

  const duck: Iv[] = [];
  const byPitch = new Map<number, Iv[]>();
  const mono = track.instrument === "vocals" || track.instrument === "bass";
  const segs = track.segments ?? [];
  for (const r of removed) {
    if (mono) {
      // vale o trecho inteiro em que o instrumento soa (respiração, reverb), até a próxima nota mantida
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
      windows(iv, startAt, (on, t) => setParam(f.gain, on ? db : 0, t));
      out.push(f);
    }
  }
  if (duck.length) {
    const g = new Tone.Gain(1);
    windows(duck, startAt, (on, t) => setParam(g.gain, on ? 0 : 1, t));
    out.push(g);
  }
  return out;
}

function synthPart(track: Track, notes: Note[], vol: Tone.Volume) {
  const events = notes.map((n) => [n.start, n] as [number, Note]);
  const bank = banks.get(track.id);
  if (bank) {
    const sampler = new Tone.Sampler({ urls: bank, release: 0.25 }).connect(vol);
    nodes.push(sampler);
    const part = new Tone.Part<any>((time: number, n: Note) => {
      const note = Tone.Frequency(n.pitch, "midi").toNote();
      if (track.kind === "drums") sampler.triggerAttack(note, time, n.velocity);
      else sampler.triggerAttackRelease(note, Math.max(n.duration, 0.08), time, n.velocity);
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
  } else {
    const wave = WAVE[track.instrument] ?? "triangle";
    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: wave },
      envelope: { attack: 0.01, release: 0.2 },
    }).connect(vol);
    synth.volume.value = wave === "sawtooth" || wave === "square" ? -20 : -10;
    nodes.push(synth);
    const part = new Tone.Part<any>((time: number, n: Note) => {
      const freq = Tone.Frequency(n.pitch, "midi").toFrequency();
      synth.triggerAttackRelease(freq, Math.max(n.duration, 0.05), time, n.velocity);
    }, events);
    part.start(0);
    parts.push(part);
  }
}

export async function play(
  tracks: PlayTrack[],
  modes: Record<string, Mode>,
  muted: Set<string>,
  solo: string | null,
  originalUrl: string,
  volumes: Record<string, number>,
  startAt: number
): Promise<boolean> {
  await Tone.start();
  stop();
  const my = token;
  const on = (id: string) => (solo ? solo === id : !muted.has(id));
  const useAudio = (t: Track) => modes[t.id] === "audio" && !!t.audio;
  const volFor = (id: string) => {
    const v = new Tone.Volume(toDb(volumes[id] ?? 80)).toDestination();
    vols.set(id, v);
    nodes.push(v);
    return v;
  };

  const audible = tracks.filter((t) => on(t.id));
  const urls = new Set(audible.filter(useAudio).map((t) => t.audio as string));
  const playOriginal = !!originalUrl && on("original");
  if (playOriginal) urls.add(originalUrl);
  const buffers = new Map<string, Tone.ToneAudioBuffer>();
  await Promise.all([
    ...[...urls].map(async (u) => buffers.set(u, await load(u))),
    ...audible
      .filter((t) => !useAudio(t) || t.edit.added.length > 0)
      .map((t) => prepareTrack(t, [...t.edit.kept, ...t.edit.removed])),
  ]);
  if (my !== token) return false;

  for (const t of audible) {
    const vol = volFor(t.id);
    if (useAudio(t)) {
      const player = new Tone.Player(buffers.get(t.audio as string)!);
      const cuts = cutFilters(t, startAt);
      player.chain(...cuts, vol);
      player.sync().start(0);
      nodes.push(player, ...cuts);
      if (t.edit.added.length) synthPart(t, t.edit.added, vol);
    } else {
      synthPart(t, t.notes, vol);
    }
  }
  if (playOriginal) {
    const player = new Tone.Player(buffers.get(originalUrl)!).connect(volFor("original"));
    player.sync().start(0);
    nodes.push(player);
  }

  Tone.Transport.seconds = startAt;
  Tone.Transport.start();
  return true;
}
