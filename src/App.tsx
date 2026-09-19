import { useEffect, useState } from "react";
import Header from "./components/layout/Header";
import Footer from "./components/layout/Footer";
import HomePage from "./pages/HomePage";
import AmbientBackground from "./components/ui/AmbientBackground";
import ScrollProgress from "./components/ui/ScrollProgress";

function App() {
  const [sukunaMode, setSukunaMode] = useState(false);
  const [easterEgg, setEasterEgg] = useState<{
    message: string;
    kind: "default" | "echidna";
  } | null>(null);

  useEffect(() => {
    const konamiCode = [
      "ArrowUp",
      "ArrowUp",
      "ArrowDown",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowLeft",
      "ArrowRight",
      "b",
      "a",
    ];
    let enteredKeys: string[] = [];
    let toastTimer: ReturnType<typeof setTimeout> | undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      enteredKeys = [...enteredKeys, event.key].slice(-konamiCode.length);
      if (enteredKeys.join(",") === konamiCode.join(",")) {
        setEasterEgg({ message: "Echidna apareció en el stream ✦", kind: "echidna" });
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => setEasterEgg(null), 5000);
        enteredKeys = [];
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (toastTimer) clearTimeout(toastTimer);
    };
  }, []);

  const activateSukunaMode = () => {
    setSukunaMode(true);
    setEasterEgg({ message: "Modo Sukuna activado", kind: "default" });
    window.setTimeout(() => setEasterEgg(null), 5000);
    window.setTimeout(() => setSukunaMode(false), 10_000);
  };

  return (
    <div
      className={`relative flex min-h-screen flex-col bg-bg-base ${sukunaMode ? "sukuna-mode" : ""}`}
    >
      <AmbientBackground
        onStarClick={() => {
          setEasterEgg({ message: "Mina dejó una estrella para ti ✦", kind: "default" });
          window.setTimeout(() => setEasterEgg(null), 5000);
        }}
      />
      <ScrollProgress />
      {sukunaMode && (
        <div className="sukuna-slashes" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      )}
      <Header onLogoDoubleClick={activateSukunaMode} />
      <main className="flex-1">
        <HomePage />
      </main>
      <Footer />
      {easterEgg?.kind === "echidna" ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-bg-base/75 px-6 backdrop-blur-sm"
          role="status"
        >
          <div className="flex max-w-sm flex-col items-center gap-4 rounded-xl border border-accent-primary/50 bg-bg-surface/95 p-6 text-center text-text-primary shadow-glow-primary">
            <img
              src="/images/echidna.gif"
              alt="Echidna"
              className="max-h-64 max-w-full object-contain"
            />
            <span>{easterEgg.message}</span>
          </div>
        </div>
      ) : easterEgg ? (
        <div
          className="fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-lg border border-accent-primary/50 bg-bg-surface/95 px-4 py-3 text-center text-sm text-text-primary shadow-glow-primary backdrop-blur-xl"
          role="status"
        >
          {easterEgg.message}
        </div>
      ) : null}
    </div>
  );
}

export default App;
