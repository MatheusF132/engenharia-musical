import * as Tone from "tone";
import type { Note, Track } from "./types";

export type Mode = "audio" | "notes";

let parts: Tone.Part<any>[] = [];
let nodes: Tone.ToneAudioNode[] = [];
let token = 0;
const cache = new Map<string, Tone.ToneAudioBuffer>();

const WAVE: Record<string, "sine" | "triangle" | "square" | "sawtooth"> = {
  bass: "sawtooth", vocals: "sine", guitar: "square", piano: "triangle", other: "sawtooth", mix: "triangle",
};

export function clearCache() {
  stop();
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

export function stop() {
  token++;
  Tone.Transport.stop();
  Tone.Transport.cancel();
  parts.forEach((p) => p.dispose());
  nodes.forEach((n) => n.dispose());
  parts = [];
  nodes = [];
}

export function getPosition() {
  return Tone.Transport.seconds;
}

export async function play(
  tracks: Track[],
  modes: Record<string, Mode>,
  muted: Set<string>,
  solo: string | null,
  originalUrl: string
): Promise<boolean> {
  await Tone.start();
  stop();
  const my = token;
  const on = (id: string) => (solo ? solo === id : !muted.has(id));
  const useAudio = (t: Track) => modes[t.id] === "audio" && !!t.audio;

  const urls = tracks.filter((t) => on(t.id) && useAudio(t)).map((t) => t.audio as string);
  if (originalUrl && on("original")) urls.push(originalUrl);
  const buffers = await Promise.all(urls.map(load));
  if (my !== token) return false;

  for (const b of buffers) {
    const player = new Tone.Player(b).toDestination();
    player.sync().start(0);
    nodes.push(player);
  }

  for (const track of tracks.filter((t) => on(t.id) && !useAudio(t))) {
    const events = track.notes.map((n) => [n.start, n] as [number, Note]);

    if (track.kind === "drums") {
      const kick = new Tone.MembraneSynth().toDestination();
      const snare = new Tone.NoiseSynth({ envelope: { attack: 0.001, decay: 0.15, sustain: 0 } }).toDestination();
      const hat = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.05, release: 0.01 } }).toDestination();
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
      }).toDestination();
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

  Tone.Transport.seconds = 0;
  Tone.Transport.start();
  return true;
}
