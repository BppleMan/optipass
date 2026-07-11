# Duplicate Semantics for Codex

Status: product semantics source of truth.

Audience: Codex and future implementation agents. This document is intentionally explicit and normative. It is not a user-facing guide.

If this document conflicts with existing code, treat the code as current implementation only, not as the intended product semantics.

## 0. Project Contract

Optipass exists to help the user find 1Password items that are likely duplicated or worth manual cleanup.

It does not promise automatic merge.
It does not replace 1Password Watchtower.
It does not search for password reuse risk.
It does not treat arbitrary equal fields as duplicate evidence.

The central product threshold is:

```text
Duplicate-like means "likely representing the same real-world login identity or same non-login record",
not "has any equal field".
```

## 1. Stable Six-Point Semantics

### 1. Password Reuse Is Out Of Scope

Same password, same password hash, same secret hash, or same concealed value must not create duplicate groups.

Reason: 1Password already checks password reuse. Optipass should not mix security-risk reporting into duplicate cleanup.

Allowed use:

- Inside an already-formed exact duplicate group, credential equality may help decide whether the records are exact duplicates.

Forbidden use:

- `same password` as a grouping key.
- `same secret hash` as a grouping key.
- `same password` as a bridge that connects otherwise unrelated items.

### 2. Normalization Scope Is Narrow

For now, normalization should stay minimal.

Allowed normalization:

- URL normalization.
- Deriving domain/site from URLs or websites.

Maybe later:

- Username trim/case normalization, only after explicit product decision.

Not needed now:

- Broad field-value normalization.
- Title fuzzy normalization beyond simple exact matching for miscellaneous non-login items.
- Arbitrary text normalization for grouping.

### 3. Core Similarity Is Login + Same Site + Same Username

The main target is login items.

Primary duplicate/similar identity anchor:

```text
login item + same site + same username
```

Site may be represented by:

- Same normalized full URL.

Confidence distinction:

- Core grouping anchor: same full URL + same username.
- Domain is useful for display and filtering, but it does not create a group by itself.

This is the key rule for the main workflow.

### 4. Every Group Still Requires Human Resolution

Even high-confidence groups are not auto-merged by default.

The UI should support manual resolution:

- keep one item,
- keep multiple items,
- archive/delete selected non-kept items,
- skip/ignore a group.

Exact duplicates may exist and should be surfaced, but they are not the most important problem. The current user already processed many obvious exact duplicates in 1Password.

### 5. Three Cleanup Classes Plus Delete Suggestions

The product model has four output classes:

```text
A. Exact duplicates
B. Similar login items
C. Miscellaneous title groups
D. Delete suggestions
```

Priority:

1. Similar login items are the core value.
2. Exact duplicates are useful but less central.
3. Miscellaneous groups are optional review.
4. Delete suggestions are advice, not duplicate groups.

No complex confidence taxonomy is required for now. Simple is better.

### 6. Do Not Enforce Max Group Size As Product Semantics

Do not define correctness by "a group cannot exceed N items".

Large groups may indicate a bad rule, but the product semantics should be rule-based, not threshold-based.

Allowed:

- Use size as a UI warning.
- Use size as a diagnostics signal.

Forbidden:

- Treat `group size > N` as the semantic reason to split or drop a group.

## 2. Output Classes

### A. Exact Duplicates

Meaning:

Items are very likely copies of the same 1Password record.

Scope:

- Primarily login items.

Grouping anchor:

```text
login item + same username set + same normalized full URL set + same credential fingerprint
```

Here, "normalized full URL" is a strict duplicate key: it may canonicalize protocol/host casing and an absent protocol, but it preserves path, query string, and hash. It must not collapse `https://example.com/` and `https://example.com/?utm=...` into the same duplicate URL.

Exactness evidence:

- Username material is fully equal.
- Normalized full URL material is fully equal.
- Credential material is fully equal.

Important:

- Credential equality is only evidence after the identity anchor already matches.
- Credential equality must not form groups by itself.
- Sharing only one username or one URL is not enough to classify the whole group as exact if the full username or URL sets differ.

Resolution:

- Manual.
- User may keep one or more items.

### B. Similar Login Items

Meaning:

Items likely represent the same real-world login identity, but contents are not identical.

This is the core Optipass workflow.

Grouping anchor:

```text
category/login + same normalized full URL + same username
```

Site matching:

- Full URL equality is required.
- Full URL equality preserves query string and hash; same domain or same path without the same query/hash is not enough.
- Domain equality is useful context, but it is not a grouping anchor.

Username matching:

- Use username-like account identity from login fields.
- Email or phone can be account identity if represented as login username/account fields.

Forbidden as standalone anchors:

- same title,
- same password/secret hash,
- same arbitrary field,
- same username without same site,
- same domain, even when username matches, without same normalized full URL.

An established similar-login group may absorb one or more incomplete login items that have credential material but no account identity when:

- the incomplete item has the same normalized URL or normalized title as a strong member of the group; and
- that weak evidence matches exactly one established account group.

This is an enrichment rule, not a standalone grouping anchor. If the incomplete item could belong to multiple account groups, it remains outside those groups for manual review. Weakly attached members lower the group confidence to medium.

Classification:

- If every item in the group also has the same credential fingerprint, classify it as an exact duplicate group.
- If the shared username + URL anchor matches but credential fingerprints or other key login material differ, classify it as a similar login group.

Resolution:

- Manual.
- User can keep one or multiple items.
- Non-kept items default to archive unless user explicitly chooses permanent delete.

### C. Miscellaneous Title Groups

Meaning:

Non-login information items with the same title may be worth optional manual review.

Grouping anchor:

```text
non-login item + same title
```

Scope:

- Non-login item types only.
- Examples: secure notes, documents, software licenses, identities, cards, servers, databases, API credentials, SSH keys, etc.

Semantics:

- This class does not strongly promise duplicate identity.
- It only says: "these non-login records share a title and may be worth reviewing."

Forbidden:

- Do not mix login items into this class.
- Do not use same title to group login items.
- Do not bridge miscellaneous groups through other equal fields.

Resolution:

- Optional manual review.
- User may ignore the group.

### D. Delete Suggestions

Meaning:

Items may be incomplete, empty shells, broken imports, old placeholders, or otherwise not useful.

This is not a duplicate group.

Scope:

- Login items.

Suggestion anchors:

```text
login item missing account identity
OR
login item missing all login credential material
```

Account identity includes:

- username,
- email,
- phone,
- other username/account fields that identify the login subject.

Login credential material includes exactly these user-confirmed field semantics:

- password,
- one-time password,
- "sign in with" / `登录方式为`.

Important interpretation:

- Missing password alone does not imply delete.
- Missing one-time password alone does not imply delete.
- Missing "sign in with" alone does not imply delete.
- Only when password, one-time password, and sign-in-with are all missing does the item lack login credential material.
- A login with a non-blank title, at least one normalizable URL, and either a one-time password or Passkey is protected from delete suggestions even when its account identity is missing.
- This protection does not create a duplicate group. Exact and similar grouping still run first, and password-only items do not receive this protection.

Phone:

- Phone may count as account identity.
- Phone does not count as credential material.

Resolution:

- Advisory only.
- User can ignore, archive, or delete.

## 3. Explicit Anti-Rules

Never create duplicate groups from these standalone facts:

- same password,
- same password hash,
- same secret hash,
- same username,
- same email,
- same phone,
- same title for login items,
- same arbitrary text field,
- same field label,
- same high-frequency URL/domain alone.

Never use connected-component union over mixed weak clues.

Bad old model:

```text
A same URL as B
B same password as C
C same title as D
=> A/B/C/D one group
```

Correct model:

```text
Each group must be produced by one explicit class anchor:
- exact duplicate anchor,
- similar login anchor,
- miscellaneous title anchor,
- delete suggestion anchor.
```

Auxiliary clues may be displayed inside a group, but they must not expand group membership.

## 4. Field Semantics For Login Items

### Account Identity

The account identity answers:

```text
Who is logging in?
```

Examples:

- username,
- email,
- phone,
- account id,
- login name.

The identity is used with site to form similar-login groups.

### Site

The site answers:

```text
Where is this login used?
```

Sources:

- item websites,
- item URLs.

Derived forms:

- normalized full URL for grouping,
- normalized domain for display and filtering.

### Credential Material

Credential material answers:

```text
What lets the user log in?
```

Current user-confirmed credential material:

- password,
- one-time password,
- sign-in-with / `登录方式为`.

Credential material is not a standalone grouping anchor.

## 5. Implementation Guardrails

When later changing code:

- Replace connected-component duplicate grouping with class-specific grouping.
- Keep exact duplicates and similar login items separate if possible.
- Keep delete suggestions separate from duplicate groups.
- Keep miscellaneous title groups separate from login groups.
- Do not implement password reuse reporting.
- Do not default to 1Password CLI account discovery.
- Do not promise automatic merge.

If adding UI filters, prefer these class labels:

- 全等重复
- 疑似相似
- 杂项组
- 可删除建议

If adding API/model fields, prefer an explicit class/type field over inferring from reasons.

Candidate naming:

```text
candidateClass: "exact-duplicate" | "similar-login" | "misc-title" | "delete-suggestion"
anchor: structured reason that formed membership
auxiliaryReasons: displayed supporting clues only
```

## 6. Current Code Caveat

Current implementation may still use `DuplicateReason` and connected grouping over title/url/username-url/secret/field.

That implementation is known to be semantically wrong for the new product contract because it can create near-whole-database groups from shared username or password-like clues.

Future work should treat this document as the target semantics.
