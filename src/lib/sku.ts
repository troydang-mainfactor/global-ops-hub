// SKU helpers. Everything joins on the base SKU (SPEC §2).

export const SIZE_SUFFIXES = ["SM", "MD", "LG", "XL", "2XL", "3XL", "OS"] as const;

/** Uppercase, trim, drop anything after the first whitespace (e.g. " - Hand Cuffs (Component)"). */
export function normalizeSku(raw: string): string {
  return raw.trim().split(/\s+/)[0].toUpperCase();
}

/** FALRNR103455RD_MD → FALRNR103455RD. Base SKUs pass through unchanged. */
export function baseSku(sku: string): string {
  const s = normalizeSku(sku);
  const i = s.indexOf("_");
  return i === -1 ? s : s.slice(0, i);
}

/** Builds a variant SKU from a base SKU and a size label from a PDF ("M", "Medium", "MD", "OS"). */
export function variantSku(base: string, size: string | null | undefined): string | null {
  if (!size) return null;
  const s = normalizeSizeLabel(size);
  return s ? `${baseSku(base)}_${s}` : null;
}

const SIZE_ALIASES: Record<string, string> = {
  S: "SM", SM: "SM", SMALL: "SM",
  M: "MD", MD: "MD", MED: "MD", MEDIUM: "MD",
  L: "LG", LG: "LG", LARGE: "LG",
  XL: "XL", XLARGE: "XL", "X-LARGE": "XL",
  "2XL": "2XL", XXL: "2XL", "2X": "2XL", "XX-LARGE": "2XL",
  "3XL": "3XL", XXXL: "3XL", "3X": "3XL",
  OS: "OS", "ONE SIZE": "OS", ONESIZE: "OS", "O/S": "OS",
};

export function normalizeSizeLabel(size: string): string | null {
  const k = size.trim().toUpperCase();
  return SIZE_ALIASES[k] ?? null;
}

/** Longest store code that the SKU starts with. Codes come from the Settings registry. */
export function storeCodeForSku(sku: string, codes: string[]): string | null {
  const s = normalizeSku(sku);
  let best: string | null = null;
  for (const c of codes) {
    const code = c.toUpperCase();
    if (code && s.startsWith(code) && (!best || code.length > best.length)) best = code;
  }
  return best;
}

/** Problems with a SKU against naming conventions (feeds rule R16 later). Empty = OK. */
export function skuConventionProblems(sku: string): string[] {
  const s = sku.trim();
  const problems: string[] = [];
  if (s !== s.toUpperCase()) problems.push("not uppercase");
  if (/\s/.test(s)) problems.push("contains spaces");
  if (!/^[A-Z0-9]+(_[A-Z0-9]+)?$/i.test(s)) problems.push("unexpected characters or more than one underscore");
  const parts = s.toUpperCase().split("_");
  if (parts.length === 2 && !(SIZE_SUFFIXES as readonly string[]).includes(parts[1])) {
    problems.push(`size suffix "${parts[1]}" is not one of ${SIZE_SUFFIXES.join(", ")}`);
  }
  if (parts.length === 1 && /-(SM|MD|LG|XL|2XL|3XL|OS)$/.test(parts[0])) {
    problems.push("size suffix uses a hyphen instead of an underscore");
  }
  return problems;
}

export function normalizeWarehouseCode(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toUpperCase();
}
