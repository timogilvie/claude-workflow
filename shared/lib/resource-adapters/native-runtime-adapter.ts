import {
  canonicalJsonStringify,
  registerResource,
  toResourceRef,
  type ResourceRef,
} from '../resource-registry.ts';

export interface NativeToolSummary {
  name: string;
  class: string;
}

export interface NativeRuntimeInput {
  /** Workflow phase (e.g. 'planning', 'review'). */
  phase: string;
  /** Native provider name (e.g. 'openai', 'openrouter'). */
  provider: string;
  /** Resolved model identifier (e.g. 'gpt-4o'). */
  model: string;
  /** Pi transport API identifier (e.g. 'openai-responses'). */
  api: string;
  /** Tools exposed to the native agent for this phase. */
  tools: readonly NativeToolSummary[];
  /** Already-registered prompt ref, if available (from logPromptUsage). */
  promptRef?: ResourceRef | null;
  repoDir?: string;
}

export interface NativeRuntimeRefs {
  /** Provider/model/api identity resource. */
  runtime: ResourceRef | null;
  /** Phase-level agent config capturing tool set and runtime provenance. */
  toolSet: ResourceRef | null;
}

/**
 * Register native agent provenance resources for a read-only phase.
 *
 * Registers a `runtime` resource capturing provider/model/api identity and an
 * `agent-config` resource capturing the phase-level tool set. Both registrations
 * are idempotent (content-hashed) and non-fatal if the registry is disabled.
 *
 * The returned refs should be fed into `recordUse(sessionId, phase, ref, repoDir)`
 * so the session manifest captures per-phase native provenance.
 */
export function registerNativeRuntime(input: NativeRuntimeInput): NativeRuntimeRefs {
  let runtime: ResourceRef | null = null;
  let toolSet: ResourceRef | null = null;

  try {
    const runtimeContent = canonicalJsonStringify({
      api: input.api,
      model: input.model,
      provider: input.provider,
    });

    runtime = toResourceRef(
      registerResource(
        {
          type: 'runtime',
          name: `${input.provider}:${input.model}`,
          content: runtimeContent,
          metadata: {
            api: input.api,
            model: input.model,
            provider: input.provider,
          },
        },
        { repoDir: input.repoDir },
      ),
    );
  } catch (err) {
    console.warn(`[native-runtime-adapter] Failed to register runtime resource: ${(err as Error).message}`);
  }

  try {
    const toolNames = [...input.tools].map((t) => t.name).sort();

    const dependencies: ResourceRef[] = [];
    if (runtime) dependencies.push(runtime);
    if (input.promptRef) dependencies.push(input.promptRef);

    const toolSetContent = canonicalJsonStringify({
      phase: input.phase,
      tools: toolNames,
    });

    toolSet = toResourceRef(
      registerResource(
        {
          type: 'agent-config',
          name: `native:${input.phase}`,
          content: toolSetContent,
          metadata: {
            api: input.api,
            model: input.model,
            phase: input.phase,
            promptRef: input.promptRef ?? null,
            provider: input.provider,
            toolNames,
          },
          dependencies,
        },
        { repoDir: input.repoDir },
      ),
    );
  } catch (err) {
    console.warn(`[native-runtime-adapter] Failed to register tool-set resource: ${(err as Error).message}`);
  }

  return { runtime, toolSet };
}
