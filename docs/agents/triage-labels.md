# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those
roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the
corresponding label string from this table.

## Where these live

Applied on the **Paca** side. Trellis's `task.json` schema has no label field —
verified: no `label` key anywhere under `.trellis/` — so triage state does not
round-trip locally. Do not assume a label is visible by re-reading `task.json`;
Trellis carries lifecycle state (`planning` / `in_progress` / `completed`) only.

## Setup caveat

These labels cannot be created until the Paca MCP server is connected. Before
relying on the mapping, confirm the Paca project accepts them as labels rather
than priorities or statuses. Until then, treat the table above as the intended
vocabulary.