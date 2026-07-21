# Hashline Patch Grammar

Hash-anchored line patch language for targeted file edits. Used by the
`edit_file` tool. Tags are path-scoped 4-hex content hashes returned by
`read_file` as `[content-tag:XXXX]`.

## File Section

```
file-section := '[' PATH '#' TAG ']' newline (op newline)*
```

TAG is the 4-hex hash from `read_file`. Line numbers are 1-based.

## Operations

| Op | Syntax | Semantics |
|----|--------|-----------|
| SWAP | `SWAP A.=B:` | Replace lines A through B with `+`-prefixed body |
| SWAP.BLK | `SWAP.BLK A:` | Replace indentation-based block starting at line A |
| DEL | `DEL A.=B` | Delete lines A through B |
| DEL.BLK | `DEL.BLK A` | Delete indentation-based block starting at line A |
| INS.PRE | `INS.PRE A:` | Insert `+`-prefixed body before line A |
| INS.POST | `INS.POST A:` | Insert `+`-prefixed body after line A |
| INS.HEAD | `INS.HEAD:` | Insert `+`-prefixed body at top of file |
| INS.TAIL | `INS.TAIL:` | Append `+`-prefixed body at end of file |

## Body

```
body := ('+' TEXT? newline)*
```

Body lines are prefixed with `+`. The `+` is stripped before content is
applied.

## Rules

1. **Order from bottom to top** (highest line first) so line numbers stay
   correct as operations apply sequentially.
2. **Read first.** Call `read_file` to get the current tag before constructing
   a `[PATH#TAG]` section. Stale tags force a re-read and retry.
3. **Indentation blocks.** SWAP.BLK and DEL.BLK resolve using indentation:
   the block starts at the given line and extends until a line with the same
   or lower indentation level (blank lines skipped).
4. **Atomic write.** Patches are applied via temp-file + `fs.rename`,
   keeping the 006 safety guarantee.

## Deferred

- `MV DEST` (move file) — rejected at parse time (`HASHLINE_PARSE_ERROR`).
- `REM` (remove file) — rejected at parse time.
- True 3-way merge recovery — stale anchors fail closed. The trivial case
  (patched snapshot matches current) succeeds; all divergence throws
  `HASHLINE_STALE_ANCHOR` (retryable).

## Example

Given `fruits.txt` with content `apple\nbanana\ncherry`:

1. `read_file` returns tag `a1f2`
2. Patch: `[fruits.txt#a1f2]\nINS.POST 1:\n+kiwi`
3. Result: `apple\nkiwi\nbanana\ncherry`

---

See `contracts/hashline-edit.md` for the full specification.
