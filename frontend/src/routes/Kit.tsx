import { Moon, Sun } from "lucide-react";
import { toast } from "sonner";

import type { components } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUi } from "@/store/ui";
import kpisJson from "@/mock/kpis.json";
import tqsJson from "@/mock/tqs.json";

type Schemas = components["schemas"];
const kpis = kpisJson as unknown as Schemas["Kpis"];
const tqs = tqsJson as unknown as Schemas["TQ"][];

const IO_COLOURS = [
  ["AI", "bg-io-ai"], ["AO", "bg-io-ao"], ["DI", "bg-io-di"], ["DO-std", "bg-io-do"],
  ["DO-iso", "bg-io-doiso"], ["Cabinet Alarm", "bg-io-alarm"],
] as const;

/** Design-system smoke page: every shadcn component on the CLAUDE.md §10 tokens, fed by real engine fixtures. */
export default function Kit() {
  const { theme, toggleTheme } = useUi();
  const stats: [string, string | number][] = [
    ["Signals", kpis.signals], ["Allocated", `${kpis.allocated_pct}%`], ["Open TQs", kpis.tqs_open],
    ["Violations", kpis.violations], ["Cabinets", kpis.cabinets], ["CIOCs", kpis.ciocs],
    ["Fill", `${kpis.fill_pct}%`], ["Wired spares", `${kpis.wired_spares} / ${kpis.wired_target}`],
  ];
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-[1200px] space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-title">Design kit</h1>
          <Button variant="outline" size="icon" aria-label="Toggle theme" onClick={toggleTheme}>
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {stats.map(([label, value]) => (
            <Card key={label}>
              <CardHeader className="p-4 pb-1"><CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle></CardHeader>
              <CardContent className="p-4 pt-0 text-xl font-semibold tnum">{value}</CardContent>
            </Card>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-sm">Controls</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button>Allocate</Button>
                <Button variant="secondary">Inject Rev B</Button>
                <Button variant="outline">Verify</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="destructive">Discard</Button>
                <Button onClick={() => toast.success("0 violations · 19/19 checks")}>Toast</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge>accent</Badge><Badge variant="secondary">secondary</Badge>
                <Badge variant="outline">outline</Badge><Badge variant="destructive">destructive</Badge>
              </div>
              <div className="flex items-center gap-3">
                <Switch defaultChecked aria-label="rule enabled" /><Switch aria-label="rule disabled" />
                <Slider defaultValue={[10]} max={30} step={1} className="w-48" aria-label="wired spare %" />
              </div>
              <div className="flex gap-2">
                <Input placeholder="Find tag  /" className="font-mono" />
                <Select defaultValue="AIR">
                  <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>{["AIR", "AOR", "DIR", "DOR"].map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="outline">Rev A ▾</Button></DropdownMenuTrigger>
                  <DropdownMenuContent><DropdownMenuItem>Rev A</DropdownMenuItem><DropdownMenuItem>Rev B</DropdownMenuItem></DropdownMenuContent>
                </DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild><Button variant="outline">Tooltip</Button></TooltipTrigger>
                  <TooltipContent>Why here?</TooltipContent>
                </Tooltip>
                <Dialog>
                  <DialogTrigger asChild><Button variant="outline">Dialog</Button></DialogTrigger>
                  <DialogContent><DialogHeader><DialogTitle>Apply fix</DialogTitle><DialogDescription>Updates the rule set and re-allocates.</DialogDescription></DialogHeader></DialogContent>
                </Dialog>
                <Sheet>
                  <SheetTrigger asChild><Button variant="outline">Inspector</Button></SheetTrigger>
                  <SheetContent><SheetHeader><SheetTitle>Slot inspector</SheetTitle><SheetDescription>Full row + Why here? trace.</SheetDescription></SheetHeader></SheetContent>
                </Sheet>
              </div>
              <Separator />
              <div className="flex items-center gap-3"><Skeleton className="h-8 w-8 rounded-full" /><Skeleton className="h-4 w-48" /></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Navigation</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Tabs defaultValue="open">
                <TabsList><TabsTrigger value="open">Open</TabsTrigger><TabsTrigger value="applied">Applied</TabsTrigger><TabsTrigger value="closed">Closed</TabsTrigger></TabsList>
                <TabsContent value="open" className="text-muted-foreground">{tqs.filter((t) => t.status === "open").length} open TQ(s) from the real engine run.</TabsContent>
                <TabsContent value="applied" className="text-muted-foreground">None applied yet.</TabsContent>
                <TabsContent value="closed" className="text-muted-foreground">None closed yet.</TabsContent>
              </Tabs>
              <Command className="rounded-lg border">
                <CommandInput placeholder="⌘K — jump to screen or tag" />
                <CommandList>
                  <CommandEmpty>No results.</CommandEmpty>
                  <CommandGroup heading="Screens"><CommandItem>Mission Control</CommandItem><CommandItem>Cabinet Floor</CommandItem><CommandItem>TQ Center</CommandItem></CommandGroup>
                </CommandList>
              </Command>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle className="text-sm">IO colours</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-4">
            {IO_COLOURS.map(([name, cls]) => (
              <span key={name} className="flex items-center gap-2"><span className={`size-3 rounded-sm ${cls}`} />{name}</span>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Spare compliance (real)</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Controller</TableHead><TableHead>IO</TableHead><TableHead className="text-right">Field</TableHead><TableHead className="text-right">Wired</TableHead><TableHead className="text-right">Target</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {kpis.spare_compliance.map((r) => (
                  <TableRow key={r.controller + r.io_type}>
                    <TableCell className="font-mono">{r.controller}</TableCell><TableCell>{r.io_type}</TableCell>
                    <TableCell className="text-right tnum">{r.field}</TableCell><TableCell className="text-right tnum">{r.wired}</TableCell>
                    <TableCell className="text-right tnum">{r.target}</TableCell>
                    <TableCell><Badge variant={r.ok ? "secondary" : "destructive"}>{r.ok ? "ok" : "short"}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}
