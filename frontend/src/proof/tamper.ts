// Tamper test (Proof Center): download the project's own exported IO Allocation workbook, change ONE cell — the CHARM Type of
// one Field row, to a CHARM the hardware map would never pick — and hand the copy back as a File. Proof then sends it to the
// independent verifier (POST /verify-file) exactly like a dropped file: the verdict is the server's, nothing is faked here.
// Same edit as scripts/make_tampered.py, done in the browser (an .xlsx is a zip of XML parts; no zip library is bundled).

const WRONG = "SE4303T03"; // RTD input CHARM: wrong for any non-RTD signal
const ALT = "SE4304T01";   // used when the row already carries WRONG

export interface Tampered {
  file: File;
  tag: string;
  row: number;
  column: string;
  from: string;
  to: string;
}

interface Entry {
  name: string;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  data: Uint8Array; // compressed bytes as stored
}

const td = new TextDecoder();
const te = new TextEncoder();

function readZip(buf: ArrayBuffer): Entry[] {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const n = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: Entry[] = [];
  for (let k = 0; k < n; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip directory");
    const method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
    const off = v.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nl));
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    out.push({ name, method, crc, csize, usize, data: u8.slice(start, start + csize) });
    p += 46 + nl + xl + cl;
  }
  return out;
}

async function inflate(e: Entry): Promise<string> {
  if (e.method === 0) return td.decode(e.data);
  if (e.method !== 8) throw new Error(`unsupported zip method ${e.method}`);
  const s = new Blob([e.data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return td.decode(await new Response(s).arrayBuffer());
}

let table: Uint32Array | null = null;
function crc32(b: Uint8Array) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Re-pack: every part keeps its compressed bytes; `replace` parts are stored uncompressed with a fresh CRC. */
function writeZip(entries: Entry[], replace: Map<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  for (const e of entries) {
    const raw = replace.get(e.name);
    const method = raw ? 0 : e.method, data = raw ?? e.data;
    const crc = raw ? crc32(raw) : e.crc, usize = raw ? raw.length : e.usize;
    const name = te.encode(e.name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(8, method, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, usize, true);
    lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(10, method, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, usize, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + data.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, csize, true);
  end.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const b of all) out.set(b, p), (p += b.length);
  return out;
}

const colOf = (ref: string) => ref.replace(/\d+$/, "");
const rowOf = (ref: string) => Number(ref.replace(/^[A-Z]+/, ""));

/** The "IO Assignment" sheet's part name (workbook.xml + its rels), else the first worksheet. */
async function sheetPart(byName: Map<string, Entry>): Promise<string> {
  const wb = byName.get("xl/workbook.xml"), rels = byName.get("xl/_rels/workbook.xml.rels");
  if (wb && rels) {
    const w = new DOMParser().parseFromString(await inflate(wb), "application/xml");
    const r = new DOMParser().parseFromString(await inflate(rels), "application/xml");
    const sheets = [...w.getElementsByTagName("sheet")];
    const sh = sheets.find((s) => s.getAttribute("name") === "IO Assignment") ?? sheets[0];
    const rid = sh?.getAttribute("r:id") ?? sh?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const target = [...r.getElementsByTagName("Relationship")].find((x) => x.getAttribute("Id") === rid)?.getAttribute("Target");
    if (target) return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  }
  return "xl/worksheets/sheet1.xml";
}

/** Fetch the exported allocation and change the CHARM Type of the n-th Field row (default 40, like make_tampered.py). */
export async function makeTampered(pid: string, nth = 40): Promise<Tampered> {
  const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/export/allocation`);
  if (!res.ok) throw new Error(`export failed (HTTP ${res.status})`);
  const disp = res.headers.get("content-disposition") ?? "";
  const base = (/filename="?([^";]+)"?/.exec(disp)?.[1] ?? "IO_Allocation.xlsx").replace(/\.xlsx$/i, "");
  const entries = readZip(await res.arrayBuffer());
  const byName = new Map(entries.map((e) => [e.name, e]));
  const part = await sheetPart(byName);
  const sheetE = byName.get(part);
  if (!sheetE) throw new Error("the export has no worksheet");
  const ssE = byName.get("xl/sharedStrings.xml");
  const shared = ssE
    ? [...new DOMParser().parseFromString(await inflate(ssE), "application/xml").getElementsByTagName("si")].map((si) =>
        [...si.getElementsByTagName("t")].map((t) => t.textContent ?? "").join(""),
      )
    : [];
  const doc = new DOMParser().parseFromString(await inflate(sheetE), "application/xml");
  const ns = doc.documentElement.namespaceURI;
  const value = (c: Element) => {
    const t = c.getAttribute("t");
    if (t === "inlineStr") return [...c.getElementsByTagName("t")].map((x) => x.textContent ?? "").join("");
    const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
    return t === "s" ? (shared[Number(v)] ?? "") : v;
  };
  const rows = [...doc.getElementsByTagName("row")];
  const head = new Map<string, string>();
  for (const c of rows[0]?.getElementsByTagName("c") ?? []) head.set(value(c).trim(), colOf(c.getAttribute("r") ?? ""));
  const colCharm = head.get("CHARM Type"), colStatus = head.get("Tag Status"), colTag = head.get("Tag Name");
  if (!colCharm || !colStatus || !colTag) throw new Error("the export has no CHARM Type / Tag Status / Tag Name column");
  let n = 0;
  for (const row of rows.slice(1)) {
    const cells = new Map([...row.getElementsByTagName("c")].map((c) => [colOf(c.getAttribute("r") ?? ""), c]));
    const st = cells.get(colStatus), ch = cells.get(colCharm);
    if (!st || !ch || value(st) !== "Field" || ++n !== nth) continue;
    const from = value(ch), to = from === WRONG ? ALT : WRONG;
    // the edited cell becomes an inline string (a shared string would change every row that uses it)
    while (ch.firstChild) ch.removeChild(ch.firstChild);
    ch.setAttribute("t", "inlineStr");
    const is = doc.createElementNS(ns, "is"), t = doc.createElementNS(ns, "t");
    t.textContent = to;
    is.appendChild(t);
    ch.appendChild(is);
    const xml = new XMLSerializer().serializeToString(doc);
    const bytes = writeZip(entries, new Map([[part, te.encode(xml)]]));
    const file = new File([bytes], `${base}_tampered.xlsx`, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    return { file, tag: cells.get(colTag) ? value(cells.get(colTag)!) : "?", row: rowOf(ch.getAttribute("r") ?? "0"), column: "CHARM Type", from, to };
  }
  throw new Error(`fewer than ${nth} Field rows in the export`);
}
