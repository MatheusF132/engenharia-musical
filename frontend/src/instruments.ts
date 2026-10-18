export type InstrumentInfo = { label: string; icon: string; color: string; hint: string };

export const INSTRUMENTS: Record<string, InstrumentInfo> = {
  drums: { label: "Bateria", icon: "🥁", color: "#ff7a59", hint: "Kick, snare e hi-hat" },
  bass: { label: "Baixo", icon: "🎸", color: "#3ecf8e", hint: "Linha grave" },
  vocals: { label: "Voz", icon: "🎤", color: "#ff6ec7", hint: "Melodia cantada" },
  guitar: { label: "Guitarra / violão", icon: "🎸", color: "#ffd166", hint: "Cordas dedilhadas ou tocadas" },
  piano: { label: "Piano / teclas", icon: "🎹", color: "#6cb8ff", hint: "Piano e teclados" },
  other: { label: "Outros", icon: "🎛️", color: "#b48cff", hint: "Sintetizadores, metais, cordas…" },
  mix: { label: "Mix completo", icon: "🎼", color: "#a0a0bd", hint: "Sem separação de instrumentos" },
};

export const ORIGINAL: InstrumentInfo = { label: "Áudio original", icon: "🔊", color: "#e0e0f0", hint: "Para comparar" };
