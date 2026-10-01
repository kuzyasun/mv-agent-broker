/** Launch configuration for the verified ZCode 0.16.9 standalone route. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BrokerError } from "../../shared/errors.ts";

export const ZCODE_ACCOUNT_PROVIDER = "account:zai-individual-coding-plan";
export const ZCODE_START_PLAN_PROVIDER = "account:zai-start-plan";
const PLAN_MODES = new Map([
  [ZCODE_ACCOUNT_PROVIDER, "individual-coding-plan"],
]);
const VERIFIED_MODEL_FAMILY = new Set(["GLM-5.3", "GLM-5.3-Flash"]);
const REASONING_LEVELS = new Set(["low", "high", "max"]);

interface ZcodeBuiltinConfig {
  schemaVersion?: number;
  config?: {
    providerConfigRules?: { providerRules?: { providerId: string; config?: { builtinModelIds?: string[]; visibility?: string; access?: { type?: string; mode?: string; accountType?: string } } }[] };
    modelConfigRules?: { builtinProviderModelRules?: { providerId: string; modelId: string; config?: { enabled?: boolean } }[] };
  };
}

/**
 * Read + schema-check the installed built-in PROGRAM provider config. This is
 * the vendor's own installed model catalog — never user settings, credentials
 * or history. Read errors and schema mismatch keep the established errors.
 */
function readZcodeBuiltin(builtinPath: string): { builtin: ZcodeBuiltinConfig; configSha256: string } {
  let raw: string;
  try { raw = readFileSync(builtinPath, "utf8"); }
  catch { throw new BrokerError("PROVIDER_INCOMPATIBLE", "Cannot read ZCode built-in provider config.", { executionStarted: false }); }
  let builtin: ZcodeBuiltinConfig;
  try { builtin = JSON.parse(raw) as ZcodeBuiltinConfig; }
  catch { throw new BrokerError("PROVIDER_INCOMPATIBLE", "Cannot read ZCode built-in provider config.", { executionStarted: false }); }
  const providers = builtin?.config?.providerConfigRules?.providerRules;
  if (builtin?.schemaVersion !== 1 || !Array.isArray(providers) || providers.some((provider) => !provider || typeof provider.providerId !== "string")) {
    throw new BrokerError("PROVIDER_INCOMPATIBLE", "Unsupported ZCode built-in provider schema.", { executionStarted: false });
  }
  return { builtin, configSha256: createHash("sha256").update(raw, "utf8").digest("hex") };
}

/** The installed built-in catalog projected for readiness observation. */
export interface ZcodeInstalledCatalog {
  provider_ids: string[];
  /** Qualified ids ("account:.../model") of the only usable account route. */
  individual_catalog: string[];
  config_sha256: string;
}

/**
 * Metadata-only catalog inspection for preflight. NO subprocess, NO /model —
 * the installed built-in PROGRAM config IS the observed catalog. Bundle
 * version comes from adjacent bundle metadata only; unknown stays null.
 */
export function readZcodeInstalledCatalog(builtinPath: string): ZcodeInstalledCatalog {
  const { builtin, configSha256 } = readZcodeBuiltin(builtinPath);
  const providers = builtin.config!.providerConfigRules!.providerRules!;
  const individual = providers.find((provider) => provider.providerId === ZCODE_ACCOUNT_PROVIDER);
  const access = individual?.config?.access;
  const models = access?.type === "zhipu-account" && access.mode === "individual-coding-plan" && access.accountType === "zai"
    ? (individual?.config?.builtinModelIds ?? []).filter((id): id is string => typeof id === "string")
    : [];
  return {
    provider_ids: providers.map((provider) => provider.providerId),
    individual_catalog: models.map((id) => `${ZCODE_ACCOUNT_PROVIDER}/${id}`),
    config_sha256: configSha256,
  };
}

export function resolveZcodeBuiltinPath(bundle: string, override?: string): string {
  const candidates = override ? [path.resolve(override)] : [
    path.resolve(path.dirname(bundle), "../config/provider/zcode-builtin.json"),
    path.resolve(path.dirname(bundle), "provider/zcode-builtin.json"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new BrokerError("PROVIDER_INCOMPATIBLE", "ZCode built-in provider config not found; set AB_ZCODE_BUILTIN_CONFIG.", { executionStarted: false });
  return found;
}

export function createZcodePersonalConfig(builtinPath: string, model: string, effort: string | null): object {
  // The installed standalone account runtime only provisions Individual.
  // A catalog entry alone is not a usable account route (native 0.16.9 probe).
  const slash = model.indexOf("/");
  const providerId = slash < 0 ? ZCODE_ACCOUNT_PROVIDER : model.slice(0, slash);
  const modelId = slash < 0 ? model : model.slice(slash + 1);
  if (providerId === ZCODE_START_PLAN_PROVIDER) {
    throw new BrokerError("PROVIDER_INCOMPATIBLE", "ZCode 0.16.9 standalone cannot authenticate Start Plan; it requires a Desktop/host account bridge. No Individual fallback.", { executionStarted: false });
  }
  const planMode = PLAN_MODES.get(providerId);
  if (!planMode) throw new BrokerError("MODEL_UNAVAILABLE", "Unsupported ZCode account plan.", { executionStarted: false });
  if (!VERIFIED_MODEL_FAMILY.has(modelId)) {
    throw new BrokerError("MODEL_UNAVAILABLE", "ZCode standalone currently supports the GLM-5.3 model family on explicitly selected Z.AI plans.", { executionStarted: false });
  }
  const reasoningLevel = effort ?? "low";
  if (!REASONING_LEVELS.has(reasoningLevel)) {
    throw new BrokerError("MODEL_UNAVAILABLE", "ZCode reasoning level must be low, high or max.", { executionStarted: false });
  }
  const { builtin } = readZcodeBuiltin(builtinPath);
  const providers = builtin.config!.providerConfigRules!.providerRules!;
  const selected = providers.find((provider) => provider.providerId === providerId);
  const access = selected?.config?.access;
  if (access?.type !== "zhipu-account" || access.mode !== planMode || access.accountType !== "zai" || !Array.isArray(selected?.config?.builtinModelIds) || !selected.config.builtinModelIds.includes(modelId)) {
    throw new BrokerError("MODEL_UNAVAILABLE", "Requested ZCode model is not in the installed selected-plan catalog.", { executionStarted: false });
  }
  const rules = builtin.config?.modelConfigRules?.builtinProviderModelRules;
  if (!Array.isArray(rules)) throw new BrokerError("PROVIDER_INCOMPATIBLE", "Unsupported ZCode model rule schema.", { executionStarted: false });
  const rule = rules.find((entry) => entry.providerId === providerId && entry.modelId === modelId);
  if (rule?.config?.enabled === false || selected.config.visibility === "hidden") {
    throw new BrokerError("MODEL_UNAVAILABLE", "Requested ZCode model is disabled in the installed catalog.", { executionStarted: false });
  }
  return {
    schemaVersion: 1,
    config: {
      // This private config cannot select another account/model as fallback.
      providerConfigRules: { providerRules: providers.filter((provider) => provider.providerId !== providerId)
        .map((provider) => ({ providerId: provider.providerId, config: { visibility: "hidden" } })) },
      modelConfigRules: {
        providerModelRules: selected.config.builtinModelIds.filter((id) => id !== modelId)
          .map((id) => ({ providerId, modelId: id, config: { enabled: false } })),
        manualProviderModelRules: [],
      },
      defaultModelSelection: { providerId, modelId, options: { reasoningLevel } },
    },
  };
}
