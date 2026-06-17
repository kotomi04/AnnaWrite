import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#272331",
        graphite: "#403a4f",
        muted: "#746f82",
        lavender: "#8b7cf8",
        violet: "#6957df",
        paper: "#fffaf5",
      },
      boxShadow: {
        glass: "0 30px 90px rgba(72,60,110,.24)",
        soft: "0 16px 42px rgba(72,60,110,.13)",
      },
    },
  },
  plugins: [],
} satisfies Config;
