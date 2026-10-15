/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // Colores como variables CSS (globals.css): Blue Neon (oscuro) y Mina Blue (claro) comparten estos nombres.
      colors: {
        bg: {
          base: "rgb(var(--c-bg-base) / <alpha-value>)",
          surface: "rgb(var(--c-bg-surface) / <alpha-value>)",
          elevated: "rgb(var(--c-bg-elevated) / <alpha-value>)",
        },
        border: {
          subtle: "rgb(var(--c-border-subtle) / <alpha-value>)",
          strong: "rgb(var(--c-border-strong) / <alpha-value>)",
        },
        accent: {
          primary: "rgb(var(--c-accent-primary) / <alpha-value>)",
          secondary: "rgb(var(--c-accent-secondary) / <alpha-value>)",
          pink: "rgb(var(--c-accent-pink) / <alpha-value>)",
          live: "rgb(var(--c-accent-live) / <alpha-value>)",
          success: "rgb(var(--c-accent-success) / <alpha-value>)",
          warning: "rgb(var(--c-accent-warning) / <alpha-value>)",
        },
        text: {
          primary: "rgb(var(--c-text-primary) / <alpha-value>)",
          secondary: "rgb(var(--c-text-secondary) / <alpha-value>)",
          muted: "rgb(var(--c-text-muted) / <alpha-value>)",
          inverse: "rgb(var(--c-text-inverse) / <alpha-value>)",
        },
      },
      fontFamily: {
        display: ["'Bebas Neue'", "sans-serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
      boxShadow: {
        "glow-primary": "0 0 20px rgb(var(--c-accent-primary) / var(--glow-alpha))",
        "glow-secondary": "0 0 20px rgb(var(--c-accent-pink) / var(--glow-alpha))",
      },
      backgroundImage: {
        "gradient-accent": "linear-gradient(90deg, rgb(var(--c-accent-primary)) 0%, rgb(var(--c-accent-pink)) 100%)",
      },
      // Pantallas de poco alto (móvil apaisado): el visor de TikTok pone el texto al lado.
      screens: {
        short: { raw: "(max-height: 520px)" },
      },
      // Transición vertical corta del visor de TikTok al cambiar de vídeo.
      keyframes: {
        "tt-in-up": {
          from: { opacity: "0", transform: "translateY(28px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "tt-in-down": {
          from: { opacity: "0", transform: "translateY(-28px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "tt-in-up": "tt-in-up 220ms ease-out",
        "tt-in-down": "tt-in-down 220ms ease-out",
      },
    },
  },
  plugins: [],
};
