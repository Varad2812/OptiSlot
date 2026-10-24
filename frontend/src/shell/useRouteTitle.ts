import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { useProject } from "@/api/hooks";

import { screenFor } from "./routes";

/** Browser tab title: "Proof · Demo — VIT Sample · OptiSlot". */
export function useRouteTitle() {
  const { pathname } = useLocation();
  const { data: p } = useProject();
  useEffect(() => {
    const s = screenFor(pathname);
    document.title = [s?.title, p?.name, "OptiSlot"].filter(Boolean).join(" · ");
  }, [pathname, p?.name]);
}
