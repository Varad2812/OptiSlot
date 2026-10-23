import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // CLAUDE.md §10 tokens (CSS vars in src/index.css)
        bg: v("bg"),
        surface: v("surface"),
        raised: v("raised"),
        border: v("border"),
        text: v("text"),
        brand: v("accent"),
        ok: v("ok"),
        warn: v("warn"),
        err: v("err"),
        // shadcn semantic names → the same tokens (components/ui/* use these)
        background: v("bg"),
        foreground: v("text"),
        card: { DEFAULT: v("surface"), foreground: v("text") },
        popover: { DEFAULT: v("raised"), foreground: v("text") },
        primary: { DEFAULT: v("accent"), foreground: v("accent-fg") },
        secondary: { DEFAULT: v("raised"), foreground: v("text") },
        muted: { DEFAULT: v("raised"), foreground: v("muted") }, // grey text = text-muted-foreground
        accent: { DEFAULT: v("hover"), foreground: v("text") }, // shadcn "accent" = hover/selected row tint
        destructive: { DEFAULT: v("err"), foreground: v("accent-fg") },
        input: v("border"),
        ring: v("accent"),
        io: {
          ai: "#3B82F6",
          ao: "#A855F7",
          di: "#10B981",
          do: "#F59E0B",
          doiso: "#EF4444",
          alarm: "#EC4899",
          spare: "#2A2F3A",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      fontSize: { ui: ["13px", "18px"], title: ["20px", { lineHeight: "28px", fontWeight: "600" }] },
      borderRadius: { DEFAULT: "8px", lg: "8px", md: "6px", sm: "4px" },
    },
  },
  plugins: [animate],
} satisfies Config;
