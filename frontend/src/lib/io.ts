// IO colours — CLAUDE.md §10.1. The single source: Tailwind (`bg-io-ai` …), the World, charts and legends all read this.
export const IO_COLOURS = {
  ai: "#4F8CFF",
  ao: "#A78BFA",
  di: "#34D399",
  do: "#FBBF24",
  doiso: "#F87171",
  alarm: "#F472B6",
  spare: "#2A3242",
} as const;

export type IoKey = "ai" | "ao" | "di" | "do" | "doiso" | "alarm" | "spare";

export const IO_LABELS: Record<IoKey, string> = {
  ai: "AI",
  ao: "AO",
  di: "DI",
  do: "DO std",
  doiso: "DO iso+fuse",
  alarm: "Cabinet alarm",
  spare: "Spare slot",
};

export const IO_ORDER: IoKey[] = ["ai", "ao", "di", "do", "doiso", "alarm"];

interface SlotLike {
  status: string;
  io_type: string;
  charm_desc?: string;
  tb_desc?: string;
}

// Isolated + fused DO is recognised from the hardware the engine assigned, never from a tag list.
const ISO = /isolat|fused/i;

/** Colour family for one slot (or one signal). Wired spares keep their IO family; the hatch shows they are spare. */
export function ioKey(s: SlotLike): IoKey {
  if (s.status === "Spare Slot") return "spare";
  if (s.status === "Cabinet Alarm") return "alarm";
  switch (s.io_type) {
    case "AIR":
    case "AI":
      return "ai";
    case "AOR":
    case "AO":
      return "ao";
    case "DIR":
    case "DI":
      return "di";
    case "DOR":
    case "DO":
      return ISO.test(`${s.charm_desc ?? ""} ${s.tb_desc ?? ""}`) ? "doiso" : "do";
    default:
      return "spare";
  }
}

export const ioColour = (k: IoKey) => IO_COLOURS[k];
