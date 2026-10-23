import { motion, useTransform, type MotionValue } from "framer-motion";
import { FileSpreadsheet } from "lucide-react";

import type { ImportSummary } from "@/api/hooks";

import { easeOut, phase } from "./shared";

/**
 * Upload Dive, overlay part (§10.4.1). Pure function of the dive progress p:
 *   0–.12 the file card shrinks into a glowing dot · .12–.30 mapping chips fly into place (stagger) and the
 *   pre-flight counts tick · .30–.42 the overlay dissolves into the World (cabinets, camera dive and the cable
 *   drop are driven by the Explorer from the same p).
 */
export function UploadDiveOverlay({ p, imp, calm }: { p: MotionValue<number>; imp: ImportSummary | undefined; calm: boolean }) {
  const opacity = useTransform(p, (v) => 1 - phase(v, calm ? 0.45 : 0.3, calm ? 0.9 : 0.42));
  const pointer = useTransform(opacity, (o) => (o < 0.05 ? "none" : "auto"));
  const card = useTransform(p, (v) => easeOut(phase(v, 0.02, 0.12)));
  const cardScale = useTransform(card, (t) => (calm ? 1 : 1 - 0.94 * t));
  const cardRadius = useTransform(card, (t) => `${calm ? 12 : 12 + t * 140}px`);
  const cardInner = useTransform(card, (t) => (calm ? 1 : 1 - Math.min(1, t * 2.2)));
  const dotGlow = useTransform(card, (t) => (calm ? 0 : t));
  const lift = useTransform(p, (v) => (calm ? 0 : -110 * easeOut(phase(v, 0.1, 0.18))));
  const mapping = (imp?.mapping ?? []).filter((m) => m.source).slice(0, 24);
  return (
    <motion.div className="absolute inset-0 z-30 grid place-items-center bg-bg/85 backdrop-blur-sm" style={{ opacity, pointerEvents: pointer }} data-testid="dive-overlay">
      <div className="relative flex w-[760px] flex-col items-center">
        <motion.div style={{ y: lift }} className="relative grid place-items-center">
          <motion.div
            className="relative flex h-[120px] w-[360px] items-center gap-4 border border-brand/40 bg-surface px-6 inner-hi"
            style={{ scale: cardScale, borderRadius: cardRadius }}
          >
            <motion.div style={{ opacity: cardInner }} className="flex min-w-0 items-center gap-4">
              <FileSpreadsheet className="size-10 shrink-0 text-ok" />
              <div className="min-w-0">
                <div className="truncate font-mono text-[14px]">{imp?.file ?? "IO_MDB.xlsx"}</div>
                <div className="mt-1 text-[12px] text-muted-foreground tnum">
                  sheet {imp?.sheet ?? "—"} · {imp?.rows ?? "…"} rows · sha {imp?.sha256?.slice(0, 8) ?? "…"}
                </div>
              </div>
            </motion.div>
          </motion.div>
          <motion.span
            className="pointer-events-none absolute size-6 rounded-full bg-live"
            style={{ opacity: dotGlow, boxShadow: "0 0 24px 8px rgb(var(--live) / .55)" }}
          />
        </motion.div>

        <div className={calm ? "mt-6 flex flex-wrap justify-center gap-1.5" : "mt-[-40px] flex flex-wrap justify-center gap-1.5"}>
          {mapping.map((m, i) => (
            <Chip key={m.field} p={p} i={i} n={mapping.length} calm={calm} label={m.label} source={m.source ?? ""} conf={m.confidence} />
          ))}
        </div>

        <div className="mt-6 grid grid-cols-3 gap-3">
          <Count p={p} label="Rows read" value={imp?.rows ?? 0} />
          <Count p={p} label="Live signals" value={imp?.live_rows ?? 0} />
          <Count p={p} label="Quarantined" value={imp?.quarantined ?? 0} warn />
        </div>
        <motion.div style={{ opacity: useTransform(p, (v) => phase(v, 0.22, 0.28)) }} className="mt-5 text-[12px] text-muted-foreground">
          Allocating into the marshalling room… <span className="text-text">press any key to skip</span>
        </motion.div>
      </div>
    </motion.div>
  );
}

function Chip({ p, i, n, label, source, conf, calm }: { p: MotionValue<number>; i: number; n: number; label: string; source: string; conf: number; calm: boolean }) {
  // ≈30 ms stagger at the cinematic duration; each chip flies in from the dot (above) to its place.
  const t = useTransform(p, (v) => easeOut(phase(v, 0.12 + i * 0.0075, 0.17 + i * 0.0075)));
  const opacity = useTransform(t, (x) => x);
  // Calm mode: the chips only fade in place.
  const y = useTransform(t, (x) => (calm ? 0 : (1 - x) * -70));
  const x = useTransform(t, (k) => (calm ? 0 : (1 - k) * ((n / 2 - i) * 14)));
  const scale = useTransform(t, (k) => (calm ? 1 : 0.6 + 0.4 * k));
  return (
    <motion.span style={{ opacity, x, y, scale }} className="flex items-center gap-1.5 rounded-chip border border-border bg-raised px-2 py-1 text-[11.5px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{source}</span>
      <span className={conf >= 0.9 ? "text-ok tnum" : "text-warn tnum"}>{Math.round(conf * 100)}%</span>
    </motion.span>
  );
}

function Count({ p, label, value, warn }: { p: MotionValue<number>; label: string; value: number; warn?: boolean }) {
  const t = useTransform(p, (v) => phase(v, 0.18, 0.3));
  const text = useTransform(t, (k) => String(Math.round(value * easeOut(k))));
  const opacity = useTransform(p, (v) => phase(v, 0.15, 0.2));
  return (
    <motion.div style={{ opacity }} className="w-[150px] rounded-card border border-border bg-surface p-3 text-center inner-hi">
      <div className="label-caps">{label}</div>
      <motion.div className={warn && value ? "mt-1 text-[24px] font-semibold text-warn tnum" : "mt-1 text-[24px] font-semibold tnum"}>{text}</motion.div>
    </motion.div>
  );
}
