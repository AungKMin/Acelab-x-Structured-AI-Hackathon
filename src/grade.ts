import type { Manifest, ManifestError, ReportedError } from "./types";

export interface GradeResult {
  reported: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
}

function normDoc(name: string | undefined): string {
  if (!name) return "";
  const base = name.trim().toLowerCase().split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(pdf|md|txt|csv|json|png|jpg)$/i, "");
}

function normCategory(cat: string | undefined): string {
  return (cat ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Collapse text for keyword comparison so honest phrasing variants still
 * match: lowercase, unify curly/prime quote characters, drop everything
 * that is not a letter, digit, or quote ("45 kVA" == "45kVA", 2″ == 2").
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[^a-z0-9'"]+/g, "");
}

function matches(m: ManifestError, r: ReportedError): boolean {
  if (normDoc(r.document) !== normDoc(m.document)) return false;
  if (normCategory(r.category) !== normCategory(m.category)) return false;

  // Exact error id always matches (teams that echo ids from the practice
  // manifest format).
  if (r.id && r.id.trim().toLowerCase() === m.id.trim().toLowerCase()) return true;

  const haystack = `${r.location ?? ""} ${r.description ?? ""}`.toLowerCase();

  const hasPage = m.page !== undefined && m.page !== null;
  const hasKeywords = (m.keywords?.length ?? 0) > 0;
  if (!hasPage && !hasKeywords) return true; // document + category suffice

  if (hasPage) {
    const numbers = (haystack.match(/\d+/g) ?? []).map((n) => parseInt(n, 10));
    if (numbers.includes(m.page as number)) return true;
  }
  if (hasKeywords) {
    const folded = fold(haystack);
    for (const kw of m.keywords ?? []) {
      if (kw && (haystack.includes(kw.toLowerCase()) || folded.includes(fold(kw)))) return true;
    }
  }
  return false;
}

/**
 * Greedy one-to-one matching: each manifest error consumes at most one
 * reported error, and each reported error matches at most one manifest
 * error. Reporting the same finding many times does not raise recall,
 * and it lowers precision.
 */
export function grade(manifest: Manifest, reportedErrors: ReportedError[]): GradeResult {
  const total = manifest.errors.length;
  const reported = reportedErrors.length;
  const used = new Set<number>();
  let matched = 0;

  for (const m of manifest.errors) {
    for (let i = 0; i < reportedErrors.length; i++) {
      if (used.has(i)) continue;
      if (matches(m, reportedErrors[i])) {
        used.add(i);
        matched++;
        break;
      }
    }
  }

  const precision = reported > 0 ? matched / reported : 0;
  const recall = total > 0 ? matched / total : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { reported, matched, precision, recall, f1 };
}

const MAX_REPORTED_ERRORS = 1000;

/** Parse and validate a submission's output.json content. */
export function parseOutput(raw: string): { errors: ReportedError[] } | { parseError: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { parseError: "output.json is not valid JSON." };
  }
  if (typeof data !== "object" || data === null || !Array.isArray((data as { errors?: unknown }).errors)) {
    return { parseError: 'output.json must be an object with an "errors" array.' };
  }
  const list = (data as { errors: unknown[] }).errors;
  if (list.length > MAX_REPORTED_ERRORS) {
    return { parseError: `output.json lists more than ${MAX_REPORTED_ERRORS} errors.` };
  }
  const errors: ReportedError[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    errors.push({
      id: typeof e.id === "string" ? e.id : undefined,
      document: typeof e.document === "string" ? e.document : undefined,
      category: typeof e.category === "string" ? e.category : undefined,
      location: typeof e.location === "string" ? e.location : undefined,
      description: typeof e.description === "string" ? e.description : undefined,
    });
  }
  return { errors };
}
