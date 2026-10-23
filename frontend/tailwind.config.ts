import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        surface: v("surface"),
        raised: v("raised"),
        border: v("border"),
        text: v("text"),
        muted: v("muted"),
        accent: v("accent"),
        ok: v("ok"),
        warn: v("warn"),
        err: v("err"),
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
