export type InstrumentInfo = { label: string; icon: string; color: string; hint: string };

export const INSTRUMENTS: Record<string, InstrumentInfo> = {
  drums: { label: "Bateria", icon: "🥁", color: "#ff7a59", hint: "Kick, snare e hi-hat" },
  vocals: { label: "Vocal", icon: "🎤", color: "#ff6ec7", hint: "Uma faixa por frase" },
  bass808: { label: "808 / Sub", icon: "🔊", color: "#2fd4a0", hint: "Grave longo e sustentado" },
  bass: { label: "Baixo", icon: "🎸", color: "#3ecf8e", hint: "Linha grave" },
  lead: { label: "Lead (melodia)", icon: "🎛️", color: "#ffd166", hint: "Melodia principal" },
  pad: { label: "Pad / Acordes", icon: "☁️", color: "#b48cff", hint: "Camadas sustentadas" },
  keys: { label: "Teclas", icon: "🎹", color: "#6cb8ff", hint: "Acordes curtos" },
  piano: { label: "Piano", icon: "🎹", color: "#5aa9ff", hint: "Piano" },
  pluck: { label: "Pluck", icon: "✨", color: "#ff9f6e", hint: "Notas curtas e secas" },
  bell: { label: "Sino / Bell", icon: "🔔", color: "#8fe3ff", hint: "Agudo cristalino" },
  strings: { label: "Cordas", icon: "🎻", color: "#e79bff", hint: "Cordas e orquestra" },
  guitar: { label: "Guitarra / Violão", icon: "🎸", color: "#f2c14e", hint: "Acordes dedilhados" },
  fx: { label: "FX / Atmosfera", icon: "🌀", color: "#9aa0ff", hint: "Efeitos e texturas" },
  other: { label: "Outro", icon: "🎼", color: "#a0a0bd", hint: "Sem classificação" },
  mix: { label: "Mix completo", icon: "🎼", color: "#a0a0bd", hint: "Sem separação de instrumentos" },
};

/** Tipos que o usuário pode escolher para uma faixa melódica (nomes usados no FL Studio). */
export const TYPE_OPTIONS = ["bass808", "bass", "lead", "pad", "keys", "piano", "pluck", "bell", "strings", "guitar", "fx", "other"];

export const ORIGINAL: InstrumentInfo = { label: "Áudio original", icon: "🔊", color: "#e0e0f0", hint: "Para comparar" };
