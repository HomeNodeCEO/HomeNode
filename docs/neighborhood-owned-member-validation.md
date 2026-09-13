# Owned neighborhood member validation

The member normalizer first copies the entire caller-supplied row through the existing canonical JSON and PostgreSQL-storage validators. That round trip returns a private JSON tree: nested objects have no caller aliases, getters, proxies or custom prototypes.

The previous implementation then repeated that same copy/storage-validation on the nested `member_data` object. The optimization retains an already-owned valid object instead. Invalid, absent or inherited values still take the original fallback, preserving their exact errors and ordering. Ambient object/array serialization hooks or a changed array iterator also retain that fallback because they can make a second serialization non-idempotent. All whole-row limits already cover the nested subtree; sorting the separate account-ID array cannot change that fact.

This is local allocation reduction, not a cache or validation receipt. Every independent digest/publication entry still copies and validates its complete input. Member/source hashes, Unicode and storage checks, account associations, source references, batch limits, cooperative checkpoints, SQL, locks and transaction deadlines remain unchanged. No caller-owned object is modified or frozen by this change.

Focused tests retain pre-change V1/V2 full-publication and member-digest goldens, invalid-shape/error precedence, exact literals, aliases, caller mutation, whole-row limits, cancellation checkpoints and independent rejection of changed publication data. A bounded copy-count assertion demonstrates removal of the duplicate nested round trip without replacing result-parity tests.

Native repository checks and the guarded dense owner replay remain release gates. Synthetic timing alone is not a production-latency or live Apply guarantee.
