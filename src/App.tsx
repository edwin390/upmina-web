import { lazy, Suspense, useEffect, useState } from "react";
import { lazyPage } from "./i18n/lazyPage";
import { Navigate, Route, Routes } from "react-router-dom";
import Header from "./components/layout/Header";
import Footer from "./components/layout/Footer";
import HomePage from "./pages/HomePage";
import TermsPage from "./pages/TermsPage";
import PrivacyPage from "./pages/PrivacyPage";
import CommunityRulesPage from "./pages/CommunityRulesPage";
import LegalNoticePage from "./pages/LegalNoticePage";
import { isLegalDocsEnabled } from "./lib/legal-docs";
import { isSignupLegalConsentEnabled } from "./lib/legal-consent";
import AmbientBackground from "./components/ui/AmbientBackground";
import ScrollProgress from "./components/ui/ScrollProgress";
import ScrollToTop from "./components/ui/ScrollToTop";
import { AuthProvider } from "./lib/auth-context";

// Cada sección es una ruta con su propio chunk: solo se descarga y renderiza la que se visita.
const TwitchSection = lazy(() => import("./components/twitch/TwitchSection"));
const YouTubeSection = lazy(() => import("./components/youtube/YouTubeSection"));
const InstagramSection = lazy(() => import("./components/instagram/InstagramSection"));
const TikTokSection = lazy(() => import("./components/tiktok/TikTokSection"));
const CommunitySection = lazyPage(
  () => import("./components/community/CommunitySection"),
  ["auth", "community", "moderation"],
);
// /@username (Fase 9J-2B): perfil público de Comunidad, su propio chunk.
const ProfilePage = lazyPage(() => import("./pages/ProfilePage"), ["auth", "community"]);
// /community/post/:postId (Fase 9J-2B.1): detalle público de una publicación, su propio chunk.
const PostDetailPage = lazyPage(
  () => import("./pages/PostDetailPage"),
  ["auth", "community", "moderation"],
);
// Fase 9I-1: su propio chunk, con use-intl y los mensajes ES/EN/DE dentro (CosplayLocaleProvider)
// — nunca entran en el bundle de las demás secciones.
const CosplayPage = lazyPage(() => import("./pages/CosplayPage"), ["cosplay"]);
const CosplayDetailPage = lazyPage(
  () => import("./pages/CosplayDetailPage"),
  ["cosplay"],
);
// Arnés de desarrollo del pipeline de medios (Fase 9I-2B): import.meta.env.DEV se resuelve en
// tiempo de build, así que Vite elimina por completo este import y la ruta que lo monta de
// cualquier build de producción — no es "oculto", literalmente no existe en ese bundle.
const MediaHarnessPage = import.meta.env.DEV
  ? lazy(() => import("./pages/dev/MediaHarnessPage"))
  : null;
// Su propio chunk: las páginas /admin/* solo se descargan al entrar a /admin/*.
const LoginPage = lazyPage(() => import("./pages/LoginPage"), ["auth"]);
const SignupPage = lazyPage(() => import("./pages/SignupPage"), ["auth"]);
const ForgotPasswordPage = lazyPage(() => import("./pages/ForgotPasswordPage"), ["auth"]);
const CopyrightClaimPage = lazyPage(
  () => import("./pages/CopyrightClaimPage"),
  ["moderation"],
);
const CopyrightAppealPage = lazyPage(
  () => import("./pages/CopyrightAppealPage"),
  ["moderation"],
);
const ResetPasswordPage = lazyPage(() => import("./pages/ResetPasswordPage"), ["auth"]);
const AccountPage = lazyPage(() => import("./pages/AccountPage"), ["account", "auth"]);
const AccountDeletionPage = lazyPage(
  () => import("./pages/AccountDeletionPage"),
  ["auth"],
);
const AdminAuthLayout = lazy(() => import("./pages/admin/AdminAuthLayout"));
const AdminLoginPage = lazyPage(() => import("./pages/admin/AdminLoginPage"), ["admin"]);
const AdminSignupPage = lazyPage(
  () => import("./pages/admin/AdminSignupPage"),
  ["admin", "auth"],
);
const AdminMfaPage = lazyPage(() => import("./pages/admin/AdminMfaPage"), ["admin"]);
const AdminActivatePage = lazyPage(
  () => import("./pages/admin/AdminActivatePage"),
  ["admin"],
);
const AdminMfaRecoveryPage = lazyPage(
  () => import("./pages/admin/AdminMfaRecoveryPage"),
  ["admin"],
);
const AdminMfaRecoveryCancelPage = lazyPage(
  () => import("./pages/admin/AdminMfaRecoveryCancelPage"),
  ["admin"],
);
const AdminDashboardPage = lazyPage(
  () => import("./pages/admin/AdminDashboardPage"),
  ["admin"],
);
const DeveloperPage = lazyPage(
  () => import("./pages/admin/DeveloperPage"),
  ["auth", "developer"],
);
const AdminModerationPage = lazyPage(
  () => import("./pages/admin/AdminModerationPage"),
  ["moderation"],
);

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
      className={`relative flex min-h-screen flex-col ${sukunaMode ? "sukuna-mode" : ""}`}
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
            <Route path="/community" element={<CommunitySection />} />
            <Route path="/comunidad" element={<Navigate to="/community" replace />} />
            <Route path="/community/post/:postId" element={<PostDetailPage />} />
            <Route path="/cosplay" element={<CosplayPage />} />
            <Route path="/cosplay/:slug" element={<CosplayDetailPage />} />
            {MediaHarnessPage && (
              <Route path="/dev/media-harness" element={<MediaHarnessPage />} />
            )}
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            {isSignupLegalConsentEnabled() || isLegalDocsEnabled() ? (
              <Route path="/community-rules" element={<CommunityRulesPage />} />
            ) : null}
            {isLegalDocsEnabled() ? (
              <Route path="/legal" element={<LegalNoticePage />} />
            ) : null}
            <Route path="/copyright" element={<CopyrightClaimPage />} />
            <Route path="/copyright/appeal" element={<CopyrightAppealPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/account" element={<AccountPage />} />
            {/* DEL-3: debe ir ANTES de /:usernameParam (que solo casa un segmento, pero así la ruta queda explícita). */}
            <Route path="/account/delete" element={<AccountDeletionPage />} />
            {/* /@username (Fase 9J-2B): React Router v6 no admite mezclar texto literal ("@") y
                un segmento dinámico dentro del MISMO segmento de ruta (matchPath("/@:username",
                "/@edwin1") devuelve null, verificado) — solo admite segmentos ENTERAMENTE
                literales o ENTERAMENTE dinámicos. Por eso la ruta real es "/:usernameParam" (todo
                "@edwin1" cae en un único param) y ProfilePage.tsx exige el prefijo "@" DENTRO del
                componente, redirigiendo como el catch-all si falta — un segmento dinámico simple
                SIEMPRE pierde frente a cualquier ruta literal en el ranking de v6 (static > dynamic
                > splat, sin importar el orden de declaración), así que esto nunca le quita
                prioridad a /community, /account, etc. */}
            <Route path="/:usernameParam" element={<ProfilePage />} />
            <Route element={<AdminAuthLayout />}>
              <Route path="/admin" element={<AdminDashboardPage />} />
              <Route path="/admin/developer" element={<DeveloperPage />} />
              <Route path="/admin/moderation" element={<AdminModerationPage />} />
              <Route path="/admin/login" element={<AdminLoginPage />} />
              <Route path="/admin/signup" element={<AdminSignupPage />} />
              <Route path="/admin/mfa" element={<AdminMfaPage />} />
              <Route path="/admin/mfa/recovery" element={<AdminMfaRecoveryPage />} />
              <Route
                path="/admin/mfa/recovery/cancel"
                element={<AdminMfaRecoveryCancelPage />}
              />
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
