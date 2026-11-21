export interface StoreRow {
  name: string;
  code: string;
  manager: string | null;
}

/**
 * Parses the store managers list: "store,store_code,manager" per line (comma or tab separated,
 * header optional, quotes allowed). Rows without a valid code are skipped.
 */
export function parseStoreCsv(text: string): StoreRow[] {
  const out: StoreRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = splitLine(line);
    if (/^store$/i.test(cells[0] ?? "") && /code/i.test(cells[1] ?? "")) continue; // header
    const [name, code, manager] = cells;
    const c = (code ?? "").toUpperCase();
    if (!name || !/^[A-Z0-9]{2,8}$/.test(c)) continue;
    out.push({ name, code: c, manager: manager || null });
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
