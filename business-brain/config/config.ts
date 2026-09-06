/**
 * Business Brain — Configuration
 *
 * Lightweight, static configuration for the Business Brain: feature flags,
 * per-engine enable/disable toggles, threshold values, and an AI
 * configuration placeholder.
 *
 * This is deliberately simple. No remote config, no persistence, no caching.
 */

/**
 * Enable/disable toggle for every engine. Keys mirror engine names.
 */
export interface EngineToggles {
  readonly metrics: boolean;
  readonly signal: boolean;
  readonly diagnosis: boolean;
  readonly constraint: boolean;
  readonly strategy: boolean;
  readonly workflow: boolean;
  readonly action: boolean;
  readonly outcome: boolean;
  readonly value: boolean;
  readonly learning: boolean;
  readonly aiExplanation: boolean;
}

/**
 * Root Business Brain configuration.
 */
export interface BusinessBrainConfig {
  /** Free-form feature flags for gating experimental behaviour. */
  readonly featureFlags: Readonly<Record<string, boolean>>;
  /** Per-engine enable/disable toggles. */
  readonly engines: EngineToggles;
  /** Named numeric thresholds consumed by engines in later phases. */
  readonly thresholds: Readonly<Record<string, number>>;
}

/*
 * There is deliberately no `ai` block here.
 *
 * One used to sit alongside `thresholds`, naming a provider and the model
 * `gemini-2.0-flash`. Nothing ever read either field: `enabled` was false,
 * `provider` and `model` had no reader anywhere in the repository, and the
 * Business Brain has no AI path to configure. It was a placeholder for a phase
 * that has not been built.
 *
 * Left in place it would have gone stale in the worst way — the real AI client
 * (lib/ai/gemini.ts) is pinned to gemini-3.1-flash-lite, so the only model
 * name a reader could find in `config/` named a model this product does not
 * use. A dead setting that contradicts the live one is worse than no setting.
 *
 * If the Business Brain ever gains an AI path, the model belongs where the
 * real one already lives, behind guardOutboundPrompt() — not in a second,
 * unguarded place. See docs/AI-DATA-HANDLING.md.
 */

/**
 * Default configuration. The whole Business Brain is disabled by default
 * because no engine has an implementation yet — phases opt engines in as
 * they are built.
 */
export const defaultConfig: BusinessBrainConfig = {
  featureFlags: {},
  engines: {
    metrics: false,
    signal: false,
    diagnosis: false,
    constraint: false,
    strategy: false,
    workflow: false,
    action: false,
    outcome: false,
    value: false,
    learning: false,
    aiExplanation: false,
  },
  thresholds: {},
};

/** Returns whether a named engine is enabled in the given config. */
export function isEngineEnabled(
  config: BusinessBrainConfig,
  engine: keyof EngineToggles,
): boolean {
  return config.engines[engine] === true;
}

/** Returns whether a named feature flag is enabled in the given config. */
export function isFeatureEnabled(
  config: BusinessBrainConfig,
  flag: string,
): boolean {
  return config.featureFlags[flag] === true;
}

/**
 * Reads a named threshold, returning `fallback` when the threshold is not set.
 */
export function getThreshold(
  config: BusinessBrainConfig,
  key: string,
  fallback: number,
): number {
  const value = config.thresholds[key];
  return typeof value === "number" ? value : fallback;
}
