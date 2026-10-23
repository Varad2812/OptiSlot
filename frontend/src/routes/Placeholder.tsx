import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";

export default function Placeholder({ title }: { title: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="text-center">
        <h1 className="text-title">{title}</h1>
        <p className="mt-1 text-muted-foreground">Screen arrives in a later phase.</p>
        <Button asChild className="mt-4" variant="outline">
          <Link to="/kit">Design kit</Link>
        </Button>
      </div>
    </div>
  );
}
