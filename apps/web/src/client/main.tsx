import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setNonce } from "get-nonce";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

import { App } from "./app.js";
import { styleNonceForDocument } from "./style-nonce.js";
import "./styles.css";

const styleNonce = styleNonceForDocument(document);
if (styleNonce) {
  // Radix's scroll-lock helper creates a runtime stylesheet and supports CSP
  // nonces through get-nonce. Set it before React mounts any dialogs/sheets.
  setNonce(styleNonce);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Agent Multiplex dashboard root is missing");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
