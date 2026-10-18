import * as Tone from "tone";
import type { Note, Track } from "./types";

let parts: Tone.Part<any>[] = [];
let nodes: Tone.ToneAudioNode[] = [];

export function stop() {
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

const WAVE: Record<string, "sine" | "triangle" | "square" | "sawtooth"> = {
  bass: "sawtooth", vocals: "sine", guitar: "square", piano: "triangle", other: "sawtooth", mix: "triangle",
};

export async function play(tracks: Track[], muted: Set<string>, solo: string | null, audioUrl: string) {
  await Tone.start();
  stop();
  const audible = tracks.filter((t) => (solo ? t.id === solo : !muted.has(t.id)));
  const originalOn = solo ? solo === "original" : !muted.has("original");
  if (originalOn) {
    const player = new Tone.Player(audioUrl).toDestination();
    await Tone.loaded();
    player.sync().start(0);
    nodes.push(player);
  }

  for (const track of audible) {
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
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: WAVE[track.instrument] ?? "triangle" },
        envelope: { attack: 0.01, release: 0.2 },
      }).toDestination();
      synth.volume.value = ["sawtooth", "square"].includes(WAVE[track.instrument]) ? -20 : -10;
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
}
