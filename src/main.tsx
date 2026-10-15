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
