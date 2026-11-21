// Parses the "MF store managers" list pasted from a sheet (tab or comma separated).
// Columns are matched by header name; without a header the order is: store, store code, manager.

export interface StoreRow {
  name: string;
  code: string | null; // Mainfactor store code
  manager: string | null; // MF store manager
  globalManager: string | null;
  tier: string | null;
  warehouseName: string | null;
  shopifyAdminUrl: string | null;
  closed: boolean;
  skuPrefixes: string[] | null; // Global SKU prefixes, if the sheet has that column; null = leave as is
}

const HEADERS: Record<keyof Omit<StoreRow, "closed" | "shopifyAdminUrl">, RegExp> = {
  name: /^(store|store name|name)$/i,
  code: /^(store code|code|store_code|mf code)$/i,
  manager: /^(mf store manager|mf manager|manager|store manager)$/i,
  globalManager: /^(global store manager|global manager)$/i,
  tier: /^tier$/i,
  warehouseName: /^warehouse$/i,
  skuPrefixes: /^(sku prefix(es)?|global (sku )?(prefix(es)?|code|acronym)s?|po (prefix|acronym)s?)$/i,
};

export function parseStoreCsv(text: string): StoreRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const first = splitLine(lines[0]);
  const hasHeader = first.some((c) => HEADERS.name.test(c)) && first.some((c) => HEADERS.code.test(c) || HEADERS.manager.test(c));
  const col: Partial<Record<keyof typeof HEADERS, number>> = {};
  if (hasHeader) {
    first.forEach((c, i) => {
      for (const [k, re] of Object.entries(HEADERS)) if (re.test(c.trim()) && col[k as keyof typeof HEADERS] === undefined) col[k as keyof typeof HEADERS] = i;
    });
  } else Object.assign(col, { name: 0, code: 1, manager: 2 });

  const out: StoreRow[] = [];
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const cells = splitLine(line);
    const get = (k: keyof typeof HEADERS) => (col[k] === undefined ? "" : (cells[col[k]!] ?? "").trim());
    let name = get("name");
    let shopifyAdminUrl: string | null = null;
    const link = name.match(/^\[(.+?)\]\((https?:\/\/[^)]+)\)$/);
    if (link) [, name, shopifyAdminUrl] = link;
    const closed = /\(closed\)/i.test(name);
    name = name.replace(/\s*\(closed\)\s*/i, " ").trim();
    if (!name) continue;
    const code = get("code").toUpperCase();
    out.push({
      name,
      code: /^[A-Z0-9]{2,8}$/.test(code) ? code : null,
      manager: get("manager") || null,
      globalManager: get("globalManager") || null,
      tier: get("tier") || null,
      warehouseName: get("warehouseName") || null,
      shopifyAdminUrl,
      closed,
      skuPrefixes: col.skuPrefixes === undefined ? null : get("skuPrefixes").split(/[\s,;/]+/).map((p) => p.toUpperCase()).filter((p) => /^[A-Z0-9]{2,8}$/.test(p)),
    });
  }
  return out;
}

function splitLine(line: string): string[] {
  const sep = line.includes("\t") ? "\t" : ",";
  const cells: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === sep && !q) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
