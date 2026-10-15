import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HeroUIProvider } from "@heroui/react";
import App from "./App";
import UpminaLocaleProvider from "./i18n/LocaleProvider";
import ActionNotice from "./components/ActionNotice";
import CommunityVisibilitySync from "./components/CommunityVisibilitySync";
import { installSocialContentCacheListener } from "./lib/social-content-cache";
import { reloadOnceForStaleChunk } from "./lib/chunk-recovery";
import "./styles/globals.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

installSocialContentCacheListener(queryClient);

// Vite emite este evento si falla la precarga de un chunk (típico tras un despliegue). Se evita el error sin
// capturar y se intenta una única recarga controlada; si ya se hizo, el error llega al límite de la ruta.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnceForStaleChunk()) event.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <CommunityVisibilitySync />
      <HeroUIProvider>
        <UpminaLocaleProvider gate>
          <BrowserRouter>
            <App />
            <ActionNotice />
          </BrowserRouter>
        </UpminaLocaleProvider>
      </HeroUIProvider>
    </QueryClientProvider>
  </StrictMode>,
);
