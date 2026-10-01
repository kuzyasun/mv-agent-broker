# Immutable physical session cwd checkpoint — 2026-10-01

ZCode Individual GLM-5.3-Flash/max authored this portion through the public
MCP broker frozen at `499d24c5fde757ca5fd1655baeea7236e1ce1ff8`.
Cursor auto independently reviewed the integrated sealed source. The coordinator
confirmed its findings against the actual diff, repaired them, and passed
`npm run typecheck` and `npm test`: **489/489 tests in 35 files**.
No real Claude was launched.

Provisioning binds a physical checkout's resolved cwd and device/inode lease
identity in the existing session-owned provision intent, atomically with ready
state. Every turn dispatches those exact cwd bytes, including native resume and
executor reconstruction. A mutable junction spelling is never the dispatched
cwd. Alias retarget or root replacement refuses later sends before consuming
their idempotency key; physical writes remain on the originally leased checkout.

Initial and final captures verify physical identity before and after capture.
A post-capture replacement invalidates the snapshot record instead of leaving
an unleased source SEALED. Known native completion remains known when its final
evidence fails; the previous trusted snapshot is retained. A missing/invalid
binding journal rolls back provisioning. A physically bound session holding a
legacy workspace-ID lease refuses dispatch rather than falling back to its
current alias.

Historically unbound physical sessions require a replacement session: recorded
native context is retained, with an explicit pre-dispatch refusal and no fresh
conversation fallback. Path-less workspaces and review slots retain their
existing behavior. This compatibility boundary was disclosed before authoring.
No DDL or public MCP schema changed. External filesystem mutation during a
native tool still requires provider enforcement; these checks do not establish
a native sandbox or descendant quiescence.

The 12 dedicated regressions cover real Windows junction retargets, identical
content in distinct physical roots, stable resume/restart cwd, legacy context,
legacy lease refusal, initial/final capture replacement and malformed journaling.
The independent review preceded coordinator fixes; the accepted Git checkpoint
and coordinator gates establish the final implementation.

Writer: `turn-bc711c3ac719db3cc7214467`, native
`sess_6af5ccc6-b52b-434b-9fee-9f0310a5b859`, baseline
`snap-d875c632a77d514c32538533`, author target
`snap-90300fe9db78a38821f3c42d`.
Reviewer: `turn-5752ec4333d84570f1f91365`, native
`8b666321-5e37-4bee-abcb-fda77c09aea5`.
The author's reported test count was not used as acceptance proof.
