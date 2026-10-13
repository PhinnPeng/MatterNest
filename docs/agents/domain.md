# Domain Docs

How the engineering skills should consume this repo's domain documentation when
exploring the codebase.

## Layout

**single-context** — one `GLOSSARY.md` and one `docs/adr/` at the repo root.

```
/
├── GLOSSARY.md
├── docs/
│   ├── adr/          ← architecture decision records
│   └── agents/       ← this skill's output (issue tracker, labels, domain rules)
└── src/
```

There is no `GLOSSARY-MAP.md` and no `src/<context>/docs/adr/`. This repo is a
single Next.js app, not a multi-package workspace.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, if it exists.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If these files don't exist, **proceed silently**. Don't flag their absence and
don't suggest creating them upfront. The `domain-modeling` skill (reached via
`grill-with-docs` and `improve-codebase-architecture`) creates them lazily when
terms or decisions actually get resolved.

## Authoritative sources that exist today

`GLOSSARY.md` and `docs/adr/` are both filling up (`docs/adr/` holds 0001–0004 as
of 2026-10-13), and this repo also has settled decision records under `docs/`.
Treat these as binding and prefer them over anything you infer from the code:

| Source | Authority for |
|---|---|
| `docs/PRD-phase1-enums-and-schemas.md` | Enum values and schemas — the single source. Never re-declare an enum elsewhere. |
| `docs/tech-stack-decision.md` §13.5 | The current eight prohibitions. **Do not read §12.3** — it contains stale Vue/Nitro wording and is marked superseded. |
| `docs/tech-stack-decision.md` §5 | Canonical directory topology (`src/app/api/**`, `src/app/lib/server/**`, `worker/**`, `src/shared/**`) |
| `.trellis/spec/**` | Layer-scoped coding guidelines, already reconciled against the code |

When output names a domain concept — an issue title, a refactor proposal, a test
name — use the term exactly as the enum/schema PRD defines it.

## Use the glossary's vocabulary

When your output names a domain concept, use the term as defined in
`GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're
inventing language the project doesn't use (reconsider) or there's a real gap
(note it for `domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than
silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_