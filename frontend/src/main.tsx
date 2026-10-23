import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppRoutes } from "@/routes";
import { useUi } from "@/store/ui";

import "./index.css";

function App() {
  const theme = useUi((s) => s.theme);
  return (
    <TooltipProvider delayDuration={150}>
      <AppRoutes />
      <Toaster theme={theme} />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
