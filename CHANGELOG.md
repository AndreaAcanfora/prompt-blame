# Changelog

## 0.1.0 (2026-11-08)

First release.

- Reads Claude Code transcripts (including subagents) incrementally, with no setup.
- Line attribution: lines still exactly as an `Edit` / `Write` / `MultiEdit` call wrote them, with neighbour-aware tie-breaking.
- VS Code: current-line annotation, hover with prompt and Claude's note, highlights per prompt, conversation view with the diff, file report, status bar share of AI lines.
- CLI: `prompt-blame <file>`, `<file>:<line>`, `stats`, `--json`.
