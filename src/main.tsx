import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HeroUIProvider } from "@heroui/react";
import App from "./App";
import ActionNotice from "./components/ActionNotice";
import "./styles/globals.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HeroUIProvider>
        <BrowserRouter>
          <App />
          <ActionNotice />
        </BrowserRouter>
      </HeroUIProvider>
    </QueryClientProvider>
  </StrictMode>,
);
