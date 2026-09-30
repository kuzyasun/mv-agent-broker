# ZCode Start Plan investigation (2026-10-01)

Decision: continue self-development on explicitly selected
`account:zai-individual-coding-plan/GLM-5.3-Flash` with `reasoningLevel=max`.
Use `GLM-5.3/high` for selected independent reviews. Start Plan remains an
unsupported standalone account route; do not silently switch plans or treat
authentication failure as exhausted quota.

## Evidence and boundary

The installed Desktop 3.14.4 / CLI 0.16.9 catalog lists both Start Plan and
Individual, including Flash in both. A real broker-dispatched Start Plan turn
failed during model creation. This does not establish Start Plan quota usage
or exhaustion. The subsequent adapter guard rejects that qualified provider
before dispatch with `PROVIDER_INCOMPATIBLE`, without Individual fallback.

The installed bundle and official standalone runtime select account providers
only when `access.mode === "individual-coding-plan"`. Request-time account
authentication rejects other modes. Login therefore cannot solve this by
changing only the default model/provider. See the official
[standalone account runtime](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts).

The official CLI README describes the normal Node bundle and optional SEA
executable as packaging of the same bundle. A different executable format
alone does not add Start Plan account support. A future release needs a
fresh capability/readiness check, not an assumption that every standalone
distribution shares this limitation forever.
[CLI packaging](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/README.md).

The app-server protocol exposes a host account overlay update and requests
request-time authentication from its client via
`interaction/requestProviderRuntimeHeaders`. It does not attach to an already
open Desktop window. Implementing the RPC responder alone does not provide a
working vendor account resolver. See official
[account config protocol](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/account-provider-config.ts) and
[runtime headers protocol](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/provider-runtime-headers.ts).

## Practical routes

| Route | Assessment | Next proof needed |
|---|---|---|
| Existing Individual CLI | Working authentication and native model/resume already smoke-tested; chosen development route | Real code task and review delivery through broker |
| Another standalone build | Packaging alone cannot fix the observed runtime restriction | Release/source evidence of native Start Plan authentication before installation/inference |
| Desktop-managed account/app-server host bridge | Plausible integration direction inferred from the official protocol; substantial separate adapter work | Documented vendor host interface, native entitlement and request-time auth resolver, then minimal model/resume smoke |
| Manual Desktop Start Plan task | Operator can use the existing signed-in app | Broker does not yet have an authenticated automated Desktop task transport |

No Desktop tokens were decrypted/copied, and no custom proxy or challenge
workaround was installed. Avoid spending more development quota on repeated
standalone Start Plan attempts until the missing host integration is available.
