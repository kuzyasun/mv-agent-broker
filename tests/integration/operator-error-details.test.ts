import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness } from "../helpers/harness.ts";
import { appendEvent } from "../../src/storage/repo.ts";
import { operatorTurnErrorResult, projectOperatorTurnError } from "../../src/operator/overview.ts";
import { readBridgeToken, startDaemonRpc } from "../../src/daemon/rpc.ts";
import { DaemonRpcClient } from "../../src/bridge/rpcClient.ts";
import { startOperatorUi } from "../../src/operator/ui.ts";

describe("operator turn error details", () => {
  it("returns the retained cause and observed flags while masking credentials and omitting private fields", async () => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession({ effort: "high" });
      const turn = h.sendTask(session.session_id, "detail");
      h.db.raw.prepare("UPDATE turns SET state='FAILED',error_code='INPUT_LIMIT',execution_started=0,termination_reason='startup_failure' WHERE turn_id=?").run(turn.turn_id);
      appendEvent(h.db, { turn_id: turn.turn_id, session_id: session.session_id, type: "turn_terminal", created_at: h.clock.now(),
        payload: { message: 'Input too large\nAuthorization: Bearer private-auth\nCookie: session=private-cookie; other=private-other\n"api_key": "private-key with spaces"\npassword=private-password', prompt: "private-prompt", native_conversation_ref: "private-ref" } });
      const detail = projectOperatorTurnError(h.db, turn.turn_id)!;
      expect(detail).toMatchObject({ error_code: "INPUT_LIMIT", execution_started: false, termination_reason: "startup_failure", recorded_failure_availability: "recorded", workspace_quarantined: false });
      expect(detail.recorded_failure_message).toContain("Input too large");
      expect(detail.guidance.next_step).toContain("Adjust the input");
      const serialized = JSON.stringify(detail);
      for (const secret of ["private-auth", "private-cookie", "private-other", "private-key", "private-password", "private-prompt", "private-ref"]) expect(serialized).not.toContain(secret);
      expect(detail.recorded_failure_message).toContain("[redacted]");
    } finally { h.cleanup(); }
  });

  it("keeps missing or malformed history unavailable and blocks immediate replay for unknown/quarantined work", async () => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession();
      const turn = h.sendTask(session.session_id, "unknown-detail");
      h.db.raw.prepare("UPDATE turns SET state='UNKNOWN',execution_started=NULL,error_code='EXECUTION_UNKNOWN' WHERE turn_id=?").run(turn.turn_id);
      h.db.raw.prepare("UPDATE workspaces SET quarantined=1,quarantine_reason='operator recovery token=private-quarantine' WHERE workspace_id=?").run(h.seed.workspaceMain);
      for (const payload of [null, "{malformed", '{"message":42}']) {
        if (payload !== null) appendEvent(h.db, { turn_id: turn.turn_id, session_id: session.session_id, type: "turn_terminal", created_at: h.clock.now(), payload });
        const detail = projectOperatorTurnError(h.db, turn.turn_id)!;
        expect(detail).toMatchObject({ execution_started: null, workspace_quarantined: true, recorded_failure_availability: "unavailable", recorded_failure_message: null });
        expect(detail.guidance.next_step).toContain("Do not start an immediate paid replay");
        expect(detail.quarantine_reason).not.toContain("private-quarantine");
      }
      expect(projectOperatorTurnError(h.db, "missing")).toBeNull();
    } finally { h.cleanup(); }
  });

  it("serves lazy details only through authenticated operator HTTP/RPC without dispatch", async () => {
    const h = createHarness();
    const root = mkdtempSync(path.join(os.tmpdir(), "broker-error-http-"));
    let rpc: Awaited<ReturnType<typeof startDaemonRpc>> | undefined;
    let ui: Awaited<ReturnType<typeof startOperatorUi>> | undefined;
    try {
      const session = await h.spawnWorkerSession();
      const turn = h.sendTask(session.session_id, "http-detail");
      h.db.raw.prepare("UPDATE turns SET state='FAILED',error_code='INPUT_LIMIT',execution_started=0 WHERE turn_id=?").run(turn.turn_id);
      appendEvent(h.db, { turn_id: turn.turn_id, session_id: session.session_id, type: "turn_terminal", created_at: h.clock.now(), payload: { message: "Recorded original cause" } });
      const stateDir = path.join(root, "state"), configPath = path.join(root, "operator.json");
      writeFileSync(configPath, JSON.stringify({ version: 1, state_dir: stateDir, coordinator_id: h.seed.coordinatorId, projects: [], coordinators: [{ coordinator_id: h.seed.coordinatorId, display_name: "Operator", allowed_project_ids: [] }], accounts: [], workspaces: [], policy_profiles: [], coverage_profiles: [], routes: [] }));
      rpc = await startDaemonRpc({ core: h.core, coordinatorId: h.seed.coordinatorId, stateDir, operator: {
        coordinatorId: h.seed.coordinatorId, status: () => ({ readiness: "READY" }),
        stop: () => { throw new Error("No stop in details fixture"); },
        turnError: params => operatorTurnErrorResult(h.db, params),
      } });
      ui = await startOperatorUi({ configPath, port: 0 });
      const endpoint = `${ui.url}/api/turn-errors/${turn.turn_id}`;
      expect((await fetch(endpoint)).status).toBe(401);
      expect((await fetch(endpoint, { headers: { "x-operator-token": ui.token, origin: "https://untrusted.invalid" } })).status).toBe(403);
      const response = await fetch(endpoint, { headers: { "x-operator-token": ui.token } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ recorded_failure_message: "Recorded original cause", execution_started: false });
      expect((await fetch(ui.url + "/api/turn-errors/missing", { headers: { "x-operator-token": ui.token } })).status).toBe(404);
      const other = new DaemonRpcClient(rpc.socketPath, readBridgeToken(stateDir));
      try {
        await other.connect(h.seed.outsiderId);
        await expect(other.request("operator/turn-error", { turn_id: turn.turn_id })).rejects.toThrow(/UNAUTHORIZED/);
      } finally { other.close(); }
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id).execution_started).toBe(false);
    } finally { await ui?.close(); await rpc?.stop(); h.cleanup(); rmSync(root, { recursive: true, force: true }); }
  });
});
