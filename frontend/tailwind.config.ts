import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

import { IO_COLOURS } from "./src/lib/io";

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // CLAUDE.md §10.1 tokens (CSS vars in src/index.css)
        bg: v("bg"),
        surface: v("surface"),
        raised: v("raised"),
        border: v("border"),
        text: v("text"),
        brand: v("brand"),
        live: v("live"),
        ok: v("ok"),
        warn: v("warn"),
        err: v("err"),
        hairline: "var(--hairline)",
        // shadcn semantic names → the same tokens (components/ui/* use these)
        background: v("bg"),
        foreground: v("text"),
        card: { DEFAULT: v("surface"), foreground: v("text") },
        popover: { DEFAULT: v("raised"), foreground: v("text") },
        primary: { DEFAULT: v("brand"), foreground: v("on-brand") },
        secondary: { DEFAULT: v("raised"), foreground: v("text") },
        muted: { DEFAULT: v("raised"), foreground: v("muted") }, // grey text = text-muted-foreground
        accent: { DEFAULT: v("hover"), foreground: v("text") }, // shadcn "accent" = hover/selected row tint
        destructive: { DEFAULT: v("err"), foreground: v("on-brand") },
        input: v("border"),
        ring: v("brand"),
        io: IO_COLOURS,
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      fontSize: {
        ui: ["13px", "18px"],
        label: ["11px", { lineHeight: "14px", letterSpacing: "0.08em", fontWeight: "500" }],
        card: ["14px", { lineHeight: "20px", fontWeight: "600" }],
        page: ["22px", { lineHeight: "28px", fontWeight: "600", letterSpacing: "-0.01em" }],
        title: ["22px", { lineHeight: "28px", fontWeight: "600" }],
      },
      borderRadius: { card: "10px", chip: "6px", DEFAULT: "10px", xl: "10px", lg: "10px", md: "6px", sm: "4px" },
      transitionTimingFunction: { out: "cubic-bezier(0.22, 1, 0.36, 1)" },
    },
  },
  plugins: [animate],
} satisfies Config;
