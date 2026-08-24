#!/usr/bin/env node
// Validate a dataset directory against the answer-key contract
// (schemas/manifest.schema.json, enforced here without dependencies).
//
//   node scripts/validate-dataset.mjs assets/datasets/test
//   node scripts/validate-dataset.mjs assets/datasets/validation
//
// Exits non-zero when the dataset would break or weaken grading.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const CATEGORIES = new Set(["cross-document-conflict", "code-violation", "unit-error", "missing-item"]);
const MAX_FILE_MB = 10;

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node scripts/validate-dataset.mjs <dataset-dir>");
  process.exit(2);
}

const errors = [];
const warnings = [];

function readJson(name) {
  const path = join(dir, name);
  if (!existsSync(path)) {
    errors.push(`${name} is missing.`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    errors.push(`${name} is not valid JSON: ${e.message}`);
    return null;
  }
}

const files = readJson("files.json");
const manifest = readJson("manifest.json");

// --- files.json ---
let fileSet = new Set();
if (files !== null) {
  if (!Array.isArray(files) || files.length === 0) {
    errors.push("files.json must be a non-empty array of file names.");
  } else {
    for (const f of files) {
      if (typeof f !== "string" || !/^[A-Za-z0-9._-]+$/.test(f)) {
        errors.push(`files.json entry ${JSON.stringify(f)} is not a plain file name (letters, digits, dot, dash, underscore).`);
        continue;
      }
      if (f === "manifest.json" || f === "files.json") {
        errors.push(`files.json must not list ${f} — it would be copied into the sandbox.`);
        continue;
      }
      const path = join(dir, f);
      if (!existsSync(path)) {
        errors.push(`files.json lists ${f} but the file does not exist.`);
        continue;
      }
      const mb = statSync(path).size / (1024 * 1024);
      if (mb > MAX_FILE_MB) warnings.push(`${f} is ${mb.toFixed(1)}MB — keep dataset files under ~${MAX_FILE_MB}MB.`);
      fileSet.add(f.toLowerCase());
    }
  }
}

// --- manifest.json ---
const normDoc = (n) => basename(String(n)).toLowerCase().replace(/\.(pdf|md|txt|csv|json|png|jpg)$/i, "");
if (manifest !== null) {
  if (!Array.isArray(manifest.errors) || manifest.errors.length === 0) {
    errors.push("manifest.json must have a non-empty errors array.");
  } else {
    const ids = new Set();
    manifest.errors.forEach((e, i) => {
      const where = `manifest error ${i + 1}${e?.id ? ` (${e.id})` : ""}`;
      if (typeof e !== "object" || e === null) return errors.push(`${where} is not an object.`);
      for (const field of ["id", "document", "category", "description"]) {
        if (typeof e[field] !== "string" || !e[field].trim()) errors.push(`${where}: "${field}" is required.`);
      }
      if (e.id) {
        if (ids.has(e.id)) errors.push(`${where}: duplicate id.`);
        ids.add(e.id);
      }
      if (e.category && !CATEGORIES.has(e.category)) {
        errors.push(`${where}: category "${e.category}" is not one of: ${[...CATEGORIES].join(", ")}.`);
      }
      if (e.document) {
        const listed = [...fileSet].some((f) => normDoc(f) === normDoc(e.document));
        if (fileSet.size > 0 && !listed) {
          errors.push(`${where}: document "${e.document}" is not in files.json — reports can never match it.`);
        }
      }
      if (e.page !== undefined && (!Number.isInteger(e.page) || e.page < 1)) {
        errors.push(`${where}: page must be a positive integer.`);
      }
      const hasKeywords = Array.isArray(e.keywords) && e.keywords.length > 0;
      if (e.keywords !== undefined && !hasKeywords) errors.push(`${where}: keywords must be a non-empty array of strings.`);
      if (hasKeywords && e.keywords.some((k) => typeof k !== "string" || !k.trim())) {
        errors.push(`${where}: every keyword must be a non-empty string.`);
      }
      if (e.page === undefined && !hasKeywords) {
        warnings.push(`${where}: no page and no keywords — ANY report with the right document+category matches it. Add 2-4 distinctive keywords.`);
      }
      if (hasKeywords && e.keywords.length === 1) {
        warnings.push(`${where}: only one keyword — add another so honest phrasing variants still match.`);
      }
    });
  }
}

// --- report ---
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
if (errors.length === 0) {
  console.log(`OK    ${dir}: ${fileSet.size} document(s), ${manifest?.errors?.length ?? 0} answer-key entries, ${warnings.length} warning(s).`);
  process.exit(0);
}
console.log(`FAIL  ${dir}: ${errors.length} error(s).`);
process.exit(1);
