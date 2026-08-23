import { createUadComplianceRegistry } from "../src/modules/uad/uadComplianceClient.js";

const modeArgument = process.argv.find((value) => value.startsWith("--mode="));
const mode = String(modeArgument?.split("=", 2)[1] || "pre-onboarding").trim();
if (!new Set(["pre-onboarding", "activation"]).has(mode)) {
  throw new Error("uad_compliance_configuration_mode_invalid");
}

const registry = createUadComplianceRegistry(process.env);
const providers = Object.fromEntries(Object.entries(registry.providers).map(([key, value]) => [
  key,
  {
    enabled: value.enabled,
    configured: value.configured,
    environment: value.environment,
    blocker_codes: value.blockers,
  },
]));
const accidentallyEnabled = registry.enabled || Object.values(providers).some((provider) => provider.enabled);
const configuredProviders = Object.values(providers).filter((provider) => provider.configured).length;
const ok = mode === "pre-onboarding"
  ? !accidentallyEnabled
  : registry.enabled && configuredProviders > 0;

console.log(JSON.stringify({
  ok,
  mode,
  global_enabled: registry.enabled,
  configured_provider_count: configuredProviders,
  providers,
  credentials_or_endpoints_exposed: false,
}, null, 2));
if (!ok) process.exitCode = 1;
