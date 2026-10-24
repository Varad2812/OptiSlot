import { Compass } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { Button } from "@/components/ui/button";

/** Any path the app does not know: say so plainly and point home. */
export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="grid h-full place-items-center p-6" data-testid="not-found">
      <div className="card-surface max-w-[420px] p-6 text-center">
        <Compass className="mx-auto size-8 text-brand" />
        <h1 className="mt-3 text-[18px] font-semibold">There is no page here</h1>
        <p className="mt-1 text-muted-foreground">
          <span className="font-mono text-[12px]">{pathname}</span> is not part of OptiSlot. Pick a step from the left, or start from Home.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Button asChild variant="outline" size="sm"><Link to="/import">Import</Link></Button>
          <Button asChild size="sm"><Link to="/">Go Home</Link></Button>
        </div>
      </div>
    </div>
  );
}
