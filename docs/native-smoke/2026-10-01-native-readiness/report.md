# Native readiness and lifetime provider binding checkpoint

The broker records bounded, non-inference readiness observations separately from requested models/effort and registered account metadata. Cursor uses the pinned `--version`, `--list-models`, and `status` channels. Antigravity uses `models`; its CLI version and authentication remain unknown. ZCode inspects the installed PROGRAM catalog without `/model` or credential reads; its current CLI version and authentication observations remain unknown. Adjacent package versions are not treated as CLI observations.

New sessions seal the account ID/provider/auth mode/quota scope, adapter version, and available readiness fingerprint into the provisioning journal. Authorization and accepted-key replay precede probes. Live account changes, invalid observations, or fingerprint drift refuse new admission. Dispatch rechecks the durable grant after admission before permission. Native legacy sessions without a durable provider tuple require replacement; historical grants are retained. This also applies to Claude/Codex legacy metadata, without running those providers.

Program hashes cover full regular file contents using fixed-memory streaming, with a 512 MiB per-file maximum and explicit refusal on oversize or concurrent change. The launch resolves a physical absolute program target. Windows wrappers also bind the actual shell bytes; the verified Cursor wrapper layout binds its selected Node interpreter and index.js, refusing ambiguous equal-date selection. Unrecognized wrapper runtime targets stay unknown. These are sampled program identities, not an immutable OS executable lock or a complete hash of every dynamically loaded dependency.

Metadata probes accept one pinned command, finite timeout/output bounds, scrubbed environments, and explicit failure rather than truncated catalogs. Errors omit native stderr headers and cookies. The cache binds exact sampled program/config fingerprints and five-minute freshness; captured authentication metadata does not prove current login or the native account identity. Registered account binding is distinct from native account identity. Generic exits/HTTP-looking stderr are not silently mapped into typed vendor quota errors.

Adapter contracts: Cursor 0.2.8, Antigravity 0.2.3, ZCode 0.2.5. Old adapter-bound sessions require replacement/revalidation. The Windows Cursor private chat-store budget remains a conservative before-permission check with a shorter AB_STATE_DIR hint. A database-open failure does not prove inference or quota consumption.

## Actual development evidence

- Original Individual GLM-5.3-Flash/max author failed with vendor code 1308 / HTTP429 and an explicit five-hour usage-limit message. Owned execution quiescence was confirmed. Its partial changes and failure remain preserved; this is not a completed author result. The vendor reset timestamp had no verified timezone.
- Cursor auto review of the partial package succeeded, identifying path-only fingerprints and unsupported ZCode version attribution.
- Gemini 3.8 Flash/high repair completed through the public MCP interface of accepted runtime 72ecb9313bbcbc11ddc1dba44f451c32920acec4. Primary review rejected prefix-only binary hashing and completed the fixes.
- Independent Cursor auto review of the integrated package succeeded (turn-3a697e8b866eb1a533f4dcc8, native 8845b208-e45d-4e85-84f2-b4eb0aa97951). Its full-source findings covered byte hashing, launch identity, nullable quota binding, wrapper identity, and malformed observations; primary repairs and offline regression checks follow.
- Claude/Codex were not launched. This checkpoint does not promote any mandatory native worker/reviewer profile or replace the full P0 gate.

## Validation

Primary full offline suite: **633 passed, 1 platform skip, 40 files**; typecheck passed. A subsequent strict persisted-binding validator repair passed typecheck and **75 targeted tests across 3 files**, including the additional corrupt-binding regression. No installed vendor CLI is launched by these tests. SDK stderr header/cookie withholding is covered with a synthetic failing Node CLI fixture.
