export type Note = { id: string; pitch: number; start: number; duration: number; velocity: number };
export type Track = { id: string; name: string; kind: "melodic" | "drums"; notes: Note[] };
export type Project = {
  name: string;
  bpm: number;
  key: string;
  duration: number;
  beats: number[];
  separated: boolean;
  tracks: Track[];
};
