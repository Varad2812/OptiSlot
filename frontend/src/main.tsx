import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/shell/states";
import { TooltipProvider } from "@/components/ui/tooltip";
import { installDemoHooks } from "@/motion/demoHooks";
import { AppRoutes } from "@/routes";
import { useUi } from "@/store/ui";

import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
});

installDemoHooks();

// A failed background promise (a dropped request, a rejected animation) is logged, never left uncaught.
window.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  console.warn("[optislot] handled rejection:", e.reason);
});

function App() {
  const theme = useUi((s) => s.theme);
  return (
    <TooltipProvider delayDuration={150}>
      <AppRoutes />
      <Toaster theme={theme} position="bottom-right" />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
