# UCCS Hackathon — Structured extraction data pack

Source PDFs (as uploaded): 1 - Drawings.pdf, 3 - Finishes Product Schedule.pdf, 4 - Plumbing Product Schedule.pdf
All bounding boxes are normalized 0-1000 on the page (origin top-left, x = left→right, y = top→bottom) unless noted. Page dimensions in points are in pages.csv.

- documents.csv — one row per source PDF (page count, extraction status)
- pages.csv — one row per page: sheet number, sheet title, discipline, page type, scale, description
- text/<doc>/page_NNN.md — extracted page text (markdown; OCR-backed)
- text_spans/<doc>/page_NNN.json — every text span on the page with its bbox (for locating text on the sheet)
- tables.csv + tables/<doc>/*.csv|*.html — every detected schedule/table (CSV = cleaned, HTML = raw incl. symbol images); tables.csv indexes them with page + bbox
- title_blocks.csv — title-block fields per page
- detections.csv / detections.json — spatial detections (sub-drawings, legends, schedules, symbols…) with bbox + category
- page_entities.json — per-page structured pulls: rooms, door tags, finish codes, grid lines, keynotes, schedule names, spec sections, code references, details/sections/elevations, callouts, notes
- symbols.csv — symbol detections (if any)
