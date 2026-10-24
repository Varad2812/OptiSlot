import type { WorldModel } from "@/api/derive";
import type { RevisionImpact } from "@/api/sandbox";
import { ioKey, type IoKey } from "@/lib/io";
import type { RevDiff3D } from "@/world3d/engine";

/**
 * The revision impact as a 3D diff on the allocation now on screen (`next`). Old looks come from the allocation the room
 * showed before (`prev`). `backward`: the impact is B-relative-to-A but the room went B → A (Rev switch back) — the same
 * changes, reversed: what was added is removed, moves fly home, modified hardware flips back.
 */
export function diff3d(impact: RevisionImpact, next: WorldModel, prev: WorldModel | null, backward = false): RevDiff3D {
  const look = (m: WorldModel | null, id?: string | null): IoKey => {
    const s = id ? m?.bySlotId.get(id) : undefined;
    return s ? ioKey(s) : "spare";
  };
  const has = (id?: string | null): id is string => !!id && next.bySlotId.has(id);
  if (!backward)
    return {
      added: impact.added.map((m) => m.to_slot).filter(has),
      removed: impact.deleted.filter((m) => has(m.from_slot)).map((m) => ({ id: m.from_slot!, io: look(prev, m.from_slot) })),
      changed: impact.modified.filter((m) => has(m.to_slot ?? m.from_slot)).map((m) => ({ id: (m.to_slot ?? m.from_slot)!, io: look(prev, m.from_slot ?? m.to_slot) })),
      moved: impact.moved.filter((m) => has(m.from_slot) && has(m.to_slot)).map((m) => ({ from: m.from_slot!, to: m.to_slot!, io: look(next, m.to_slot) })),
    };
  return {
    added: impact.deleted.map((m) => m.from_slot).filter(has),
    removed: impact.added.filter((m) => has(m.to_slot)).map((m) => ({ id: m.to_slot!, io: look(prev, m.to_slot) })),
    changed: impact.modified.filter((m) => has(m.from_slot ?? m.to_slot)).map((m) => ({ id: (m.from_slot ?? m.to_slot)!, io: look(prev, m.to_slot ?? m.from_slot) })),
    moved: impact.moved.filter((m) => has(m.from_slot) && has(m.to_slot)).map((m) => ({ from: m.to_slot!, to: m.from_slot!, io: look(next, m.from_slot) })),
  };
}

export const diffSize = (d: RevDiff3D) => d.added.length + d.removed.length + d.changed.length + d.moved.length;
