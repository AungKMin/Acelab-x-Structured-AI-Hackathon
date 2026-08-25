"""Self-grade output.json against a manifest. Port of src/grade.ts — that file is
the authority; if the two ever disagree, src/grade.ts wins.

    python3 grade_output.py output.json examples/practice-dataset/manifest.json
"""

import json
import re
import sys

EXT = re.compile(r"\.(pdf|md|txt|csv|json|png|jpg)$", re.I)


def norm_doc(name):
    return EXT.sub("", re.split(r"[\\/]", (name or "").strip().lower())[-1])


def norm_category(cat):
    return re.sub(r"[^a-z0-9]+", "-", (cat or "").strip().lower()).strip("-")


def fold(text):
    text = re.sub(r"[‘’′]", "'", text.lower())
    text = re.sub(r"[“”″]", '"', text)
    return re.sub(r"[^a-z0-9'\"]+", "", text)


def derive_anchors(m):
    source = f"{m.get('location') or ''} {m.get('description') or ''}"
    tokens = re.split(r"[^A-Za-z0-9/-]+", source)
    return list(dict.fromkeys(t for t in tokens if re.search(r"\d", t) and len(t) >= 2))


def matches(m, r):
    if norm_doc(r.get("document")) != norm_doc(m.get("document")):
        return False
    if norm_category(r.get("category")) != norm_category(m.get("category")):
        return False
    if r.get("id") and m.get("id") and r["id"].strip().lower() == m["id"].strip().lower():
        return True

    haystack = f"{r.get('location') or ''} {r.get('description') or ''}".lower()
    page = m.get("page")
    keywords = m.get("keywords") or derive_anchors(m)
    if page is None and not keywords:
        return True  # document + category suffice
    if page is not None and page in [int(n) for n in re.findall(r"\d+", haystack)]:
        return True
    folded = fold(haystack)
    return any(kw and (kw.lower() in haystack or fold(kw) in folded) for kw in keywords)


def grade(manifest, reports):
    used, matched = set(), 0
    for m in manifest["errors"]:
        for i, r in enumerate(reports):
            if i not in used and matches(m, r):
                used.add(i)
                matched += 1
                break
    precision = matched / len(reports) if reports else 0.0
    recall = matched / len(manifest["errors"]) if manifest["errors"] else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"reported": len(reports), "matched": matched,
            "precision": precision, "recall": recall, "f1": f1}


def demo():
    key = {"errors": [
        {"id": "P01", "document": "schedule.pdf", "category": "cross-document-conflict",
         "keywords": ["D-202", "45 min"]},
        {"id": "P02", "document": "schedule.pdf", "category": "unit-error",
         "keywords": ["L-1", "5.0 gpm"]},
    ]}
    hit = {"document": "SCHEDULE.PDF", "category": "Cross Document Conflict",
           "location": "page 1", "description": "D-202 rated 45min, spec needs 90 min"}
    hit2 = {"document": "schedule.pdf", "category": "unit-error",
            "location": "L-1", "description": "listed at 5.0gpm, spec requires 0.5 gpm"}
    miss = {"document": "schedule.pdf", "category": "code-violation",
            "location": "x", "description": "unrelated"}

    # case-folded doc, dashed category, folded keyword ("45 min" vs "45min") all match
    assert grade(key, [hit, hit2])["f1"] == 1.0
    # a duplicate cannot raise recall and does lower precision
    assert grade(key, [hit, hit2, dict(hit)])["precision"] == 2 / 3
    # wrong category never matches even with perfect keywords
    assert grade(key, [miss])["matched"] == 0
    assert grade(key, [])["f1"] == 0.0
    # fold() must collapse spacing and curly/prime quotes the way grade.ts does
    assert fold("45 kVA") == fold("45kVA")
    assert fold("2\u2033") == fold('2"')
    assert fold("\u201cP-1\u201d") == fold('"P-1"')
    print("self-check ok")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--demo":
        demo()
        sys.exit()
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    reports = json.load(open(sys.argv[1]))["errors"]
    manifest = json.load(open(sys.argv[2]))
    r = grade(manifest, reports)
    print(f"reported {r['reported']}  matched {r['matched']}  "
          f"P {r['precision']:.3f}  R {r['recall']:.3f}  F1 {r['f1']:.3f}")
