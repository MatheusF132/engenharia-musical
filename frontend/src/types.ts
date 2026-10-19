export type Note = { id: string; pitch: number; start: number; duration: number; velocity: number };
export type Track = { id: string; name: string; instrument: string; kind: "melodic" | "drums"; audio: string | null; segments?: [number, number][]; notes: Note[] };
export type Project = {
  name: string;
  bpm: number;
  key: string;
  duration: number;
  beats: number[];
  separated: boolean;
  separation_error: string | null;
  audio_url: string;
  tracks: Track[];
};
