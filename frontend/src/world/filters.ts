import type { Slot } from "@/api/hooks";
import { ioKey } from "@/lib/io";
import { NO_FILTERS, type ExplorerFilters } from "@/store/ui";

/** Explorer / 3D Room filter chips → a slot predicate (null = no filter, nothing dims). */
export function matcher(f: ExplorerFilters): ((s: Slot) => boolean) | null {
  if (f === NO_FILTERS || (!f.io.length && !f.status.length && !f.family.length && !f.group && !f.search.trim())) return null;
  const q = f.search.trim().toLowerCase().replace(/\s+/g, "");
  return (s) =>
    (!f.io.length || f.io.includes(ioKey(s))) &&
    (!f.status.length || f.status.includes(s.status)) &&
    (!f.family.length || f.family.includes(s.family ?? "-")) &&
    (!f.group || s.group === f.group) &&
    (!q || s.tag_key.toLowerCase().includes(q) || s.cable.toLowerCase().includes(q));
}
