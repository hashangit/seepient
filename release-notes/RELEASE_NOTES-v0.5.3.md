# Seepient v0.5.3 Release Notes

**Seepient v0.5.3** fixes assistant markdown ordered-list rendering across all TUI surfaces (live streaming, committed history entries, tool output views, and session restores). It eliminates the render-time numbering heuristic and replaces it with deterministic parse-time scan-state list grouping and precomputed markers.

---

## 🔧 Fixes & Improvements

### Parse-Time Markdown List Grouping & Numbering
- **Deterministic Scan-State**: Replaced fragile render-time counters (`ordDepth`, `ordNum`, `ordMarker`) with a parse-time `orderedMap` tracking depth levels, literal start numbers, and continuations.
- **Loose List Continuity**: Preserves sequential ordered numbering (`1.`, `2.`, `3.`) across loose lists with blank lines between items without resetting.
- **Indented Continuation Line Absorption**: Absorbs wrapped and indented continuation lines directly into the parent list item.
- **Interrupted & Nested Lists**: Preserves outer list numbering across deeper nested bullet lists and inner ordered-list excursions.
- **Marker Formats & CRLF**: Extended ordered list matching to accept both dot (`1.`) and paren (`1)`) markers, and normalized CRLF line endings upfront.
