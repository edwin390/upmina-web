import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Header from "./components/layout/Header";
import Footer from "./components/layout/Footer";
import HomePage from "./pages/HomePage";
import TermsPage from "./pages/TermsPage";
import PrivacyPage from "./pages/PrivacyPage";
import AmbientBackground from "./components/ui/AmbientBackground";
import ScrollProgress from "./components/ui/ScrollProgress";
import ScrollToTop from "./components/ui/ScrollToTop";
import { AuthProvider } from "./lib/auth-context";

// Cada sección es una ruta con su propio chunk: solo se descarga y renderiza la que se visita.
const TwitchSection = lazy(() => import("./components/twitch/TwitchSection"));
const YouTubeSection = lazy(() => import("./components/youtube/YouTubeSection"));
const InstagramSection = lazy(() => import("./components/instagram/InstagramSection"));
const TikTokSection = lazy(() => import("./components/tiktok/TikTokSection"));
const CommunitySection = lazy(() => import("./components/community/CommunitySection"));
// Su propio chunk: las páginas /admin/* solo se descargan al entrar a /admin/*.
const LoginPage = lazy(() => import("./pages/LoginPage"));
const SignupPage = lazy(() => import("./pages/SignupPage"));
const AdminAuthLayout = lazy(() => import("./pages/admin/AdminAuthLayout"));
const AdminLoginPage = lazy(() => import("./pages/admin/AdminLoginPage"));
const AdminSignupPage = lazy(() => import("./pages/admin/AdminSignupPage"));
const AdminMfaPage = lazy(() => import("./pages/admin/AdminMfaPage"));
const AdminActivatePage = lazy(() => import("./pages/admin/AdminActivatePage"));
const AdminDashboardPage = lazy(() => import("./pages/admin/AdminDashboardPage"));

function SectionFallback() {
  return (
    <div className="mx-auto min-h-[420px] max-w-6xl px-4 py-16" aria-hidden="true" />
  );
}

function AppShell() {
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
      <ScrollToTop />
      <Header onLogoDoubleClick={activateSukunaMode} />
      <main className="flex-1">
        <Suspense fallback={<SectionFallback />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/twitch" element={<TwitchSection />} />
            <Route path="/youtube" element={<YouTubeSection />} />
            <Route path="/instagram" element={<InstagramSection />} />
            <Route path="/tiktok" element={<TikTokSection />} />
            <Route path="/comunidad" element={<CommunitySection />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route element={<AdminAuthLayout />}>
              <Route path="/admin" element={<AdminDashboardPage />} />
              <Route path="/admin/login" element={<AdminLoginPage />} />
              <Route path="/admin/signup" element={<AdminSignupPage />} />
              <Route path="/admin/mfa" element={<AdminMfaPage />} />
              <Route path="/admin/activate" element={<AdminActivatePage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
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

// Único AuthProvider de la app (Bloque 6A): una sola fuente de sesión y un solo listener
// de Supabase Auth para rutas públicas y /admin/*. supabase-js se carga de forma diferida
// dentro del provider, así que no entra en el bundle crítico de Home.
function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

export default App;
