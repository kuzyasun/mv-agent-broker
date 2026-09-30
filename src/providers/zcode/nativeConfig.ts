/** Launch configuration for the verified ZCode 0.16.9 standalone route. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BrokerError } from "../../shared/errors.ts";

export const ZCODE_ACCOUNT_PROVIDER = "account:zai-individual-coding-plan";
const VERIFIED_MODEL_FAMILY = new Set(["GLM-5.3", "GLM-5.3-Flash"]);
const REASONING_LEVELS = new Set(["low", "high", "max"]);

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
  const modelId = model.startsWith(`${ZCODE_ACCOUNT_PROVIDER}/`) ? model.slice(ZCODE_ACCOUNT_PROVIDER.length + 1) : model;
  if (!VERIFIED_MODEL_FAMILY.has(modelId)) {
    throw new BrokerError("MODEL_UNAVAILABLE", "ZCode standalone currently supports GLM-5.3 and GLM-5.3-Flash on Z.AI Individual Coding Plan.", { executionStarted: false });
  }
  const reasoningLevel = effort ?? "low";
  if (!REASONING_LEVELS.has(reasoningLevel)) {
    throw new BrokerError("MODEL_UNAVAILABLE", "ZCode reasoning level must be low, high or max.", { executionStarted: false });
  }
  let builtin: {
    schemaVersion?: number;
    config?: {
      providerConfigRules?: { providerRules?: { providerId: string; config?: { builtinModelIds?: string[]; visibility?: string; access?: { type?: string; mode?: string; accountType?: string } } }[] };
      modelConfigRules?: { builtinProviderModelRules?: { providerId: string; modelId: string; config?: { enabled?: boolean } }[] };
    };
  };
  try { builtin = JSON.parse(readFileSync(builtinPath, "utf8")); }
  catch { throw new BrokerError("PROVIDER_INCOMPATIBLE", "Cannot read ZCode built-in provider config.", { executionStarted: false }); }
  const providers = builtin?.config?.providerConfigRules?.providerRules;
  if (builtin?.schemaVersion !== 1 || !Array.isArray(providers) || providers.some((provider) => !provider || typeof provider.providerId !== "string")) {
    throw new BrokerError("PROVIDER_INCOMPATIBLE", "Unsupported ZCode built-in provider schema.", { executionStarted: false });
  }
  const selected = providers.find((provider) => provider.providerId === ZCODE_ACCOUNT_PROVIDER);
  const access = selected?.config?.access;
  if (access?.type !== "zhipu-account" || access.mode !== "individual-coding-plan" || access.accountType !== "zai" || !Array.isArray(selected?.config?.builtinModelIds) || !selected.config.builtinModelIds.includes(modelId)) {
    throw new BrokerError("MODEL_UNAVAILABLE", "Requested ZCode model is not in the installed Z.AI individual catalog.", { executionStarted: false });
  }
  const rules = builtin.config?.modelConfigRules?.builtinProviderModelRules;
  if (!Array.isArray(rules)) throw new BrokerError("PROVIDER_INCOMPATIBLE", "Unsupported ZCode model rule schema.", { executionStarted: false });
  const rule = rules.find((entry) => entry.providerId === ZCODE_ACCOUNT_PROVIDER && entry.modelId === modelId);
  if (rule?.config?.enabled === false || selected.config.visibility === "hidden") {
    throw new BrokerError("MODEL_UNAVAILABLE", "Requested ZCode model is disabled in the installed catalog.", { executionStarted: false });
  }
  return {
    schemaVersion: 1,
    config: {
      // This private config cannot select another account/model as fallback.
      providerConfigRules: { providerRules: providers.filter((provider) => provider.providerId !== ZCODE_ACCOUNT_PROVIDER)
        .map((provider) => ({ providerId: provider.providerId, config: { visibility: "hidden" } })) },
      modelConfigRules: {
        providerModelRules: selected.config.builtinModelIds.filter((id) => id !== modelId)
          .map((id) => ({ providerId: ZCODE_ACCOUNT_PROVIDER, modelId: id, config: { enabled: false } })),
        manualProviderModelRules: [],
      },
      defaultModelSelection: { providerId: ZCODE_ACCOUNT_PROVIDER, modelId, options: { reasoningLevel } },
    },
  };
}
