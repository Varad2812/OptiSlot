import { useEffect } from "react";
import { toast } from "sonner";

import { useAllocation, useProjectId } from "@/api/hooks";

const PREFIX = "Auto-migrated";
const told = new Set<string>();

/** One line, once: the backend brought an older project database up to date (new default rule fields merged in). */
export function useMigrationNotice() {
  const pid = useProjectId();
  const { data } = useAllocation();
  const ev = data?.activity?.find((e) => e.text.startsWith(PREFIX));
  useEffect(() => {
    if (!ev) return;
    const key = `optislot.migrated.${pid}.${ev.ts}`;
    let seen = told.has(key);
    try {
      seen = seen || localStorage.getItem(key) === "1";
      localStorage.setItem(key, "1");
    } catch {
      /* storage can be blocked: the in-memory set still stops repeats within this session */
    }
    told.add(key);
    if (!seen) toast.info(ev.text);
  }, [pid, ev]);
}
