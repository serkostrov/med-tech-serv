import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { ToastHost } from "./components/ui/toast.js";
import { App } from "./App.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element is missing");
}

createRoot(rootElement).render(
  <StrictMode>
    <TooltipProvider delayDuration={250}>
      <App />
      <ToastHost />
    </TooltipProvider>
  </StrictMode>
);
