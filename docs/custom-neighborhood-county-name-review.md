# Recorded county-name variants in Custom pocket review

Existing retained catalogs can contain separate `Dallas` and `DALLAS COUNTY`
groups for the same recorded subdivision label. Rewriting their IDs on reopen
would silently change a saved selection when one group was included and the
other excluded. This update keeps those identities, counts, scores and exact
saved memberships intact.

The checked complete catalog now supports an explicit review convenience:

- Inspect a group to see matching subdivision labels under supported county-name
  variants, including groups outside the current list page.
- **Include matching groups** or **Exclude matching groups** changes that exact
  union only; unrelated included groups stay unchanged.
- **Preview subject's matching county-name groups** explicitly replaces the
  exploration selection with all matching groups for the subject's recorded label.
- Merely opening, searching, paging or inspecting never changes inclusion.

Only case, whitespace and the literal `County` suffix are normalized for the
supported DFW county names. Different counties, unknown counties, other states,
phase numbers, punctuation and approximate subdivision names are not merged.
This is recorded-name comparison, not proof of common legal subdivision or builder
identity. The original individual-group controls remain available.

All actions use the existing checkpoint save, selection revision and coherent
map/statistics preview path. Read-only, pending-capture, stale-reload and in-flight
save barriers remain. No API, source mapping, database migration, report Apply,
historical eligibility, score weights or legal boundary geometry changes occur.

Tests cover the real server mapper/catalog/presenter to browser boundary, exact
selected unions, empty/partial saved membership, unknown and different counties,
different phases, all 887 catalog groups across list pages, independent inspection,
and the existing ownership barriers.

Future canonical source identity must be versioned at capture and preserve prior
context replay. Do not remove a suffix in the shared source database or rewrite
saved catalog IDs as a shortcut.
