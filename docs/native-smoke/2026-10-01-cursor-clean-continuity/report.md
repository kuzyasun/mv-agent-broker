# Cursor 0.2.4 clean continuity falsification

Frozen runtime `499d24c5fde757ca5fd1655baeea7236e1ce1ff8`, Cursor `auto`.
Two retained sealed snapshots were reviewed without capturing the active
writer's repository. The first prompt carried a fresh harmless memory tag;
the second serialized request was asserted not to contain its value. No file
search/cache reading was authorized to recover it.

Both native turns completed with the same logical session and observed
conversation `a9ac2fe5-2884-4928-9888-c5d40ad34146`:
`turn-d7eccdfaa3a05dc0d06a3230` then `turn-5ce905dc49c6692698e2d1b8`.
S1 was `snap-2945dcbc02b64fc1240b7925`; S2 was
`snap-c972be86f8e2964bc1300a5c`. The agent described the actual source change
from no physical_bindings to physical_bindings and flat native commands.
Readability is agent-reported, with native hook receipts retained privately.

**Memory recall failed.** The second report omitted the exact tag and explicitly
reported no earlier turn content. Two workflow SUCCEEDED states and unchanged
native UUID are not a continuity pass.

The coordinator inspected only installed CLI PROGRAM source, not chats,
credentials or user caches. In `2026.09.28-64d2043`, index.js
`../cursor-config/dist/paths.js` exports WI as the CURSOR_CONFIG_DIR resolver;
1250.index.js and 3547.index.js `./src/state/index.ts` derive native chats from
`join(WI(), 'chats')` and the resolved process.cwd hash. CURSOR_DATA_DIR serves
other storage. Adapter0.2.4 creates and deletes a unique CURSOR_CONFIG_DIR per
reviewer turn, so its cleanup destroys the history root. A stable private
per-session config root, separate immutable per-turn policy/audit, and a fresh
clean native rerun are required. The restricted full profile remains unverified.
