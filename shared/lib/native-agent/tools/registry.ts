import type { ToolDescriptor, ToolMetadata, ToolPhase } from './types.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DuplicateToolError extends Error {
  override name = 'DuplicateToolError';
  constructor(toolName: string) {
    super(`Tool "${toolName}" is already registered`);
  }
}

export class UnknownToolError extends Error {
  override name = 'UnknownToolError';
  constructor(toolName: string) {
    super(`Unknown tool requested: "${toolName}"`);
  }
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export interface ToolRegistryRequest {
  /** Filter by phase. If omitted, all phases are included. */
  phase?: ToolPhase;
  /**
   * Filter to a specific set of names.
   * - Empty array returns [].
   * - Unknown names throw UnknownToolError before returning anything.
   * - Known names that do not match the phase filter are silently excluded.
   * - Results are always returned in registration order, not request order.
   */
  names?: readonly string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ToolRegistry {
  /**
   * Register a tool descriptor.
   * Throws DuplicateToolError if a tool with the same name is already registered.
   * State is unchanged on error.
   */
  register(descriptor: ToolDescriptor): void;

  /**
   * Return full descriptors matching the request.
   * Order is deterministic: registration order, not request order.
   */
  getTools(request?: ToolRegistryRequest): ToolDescriptor[];

  /**
   * Return metadata-only entries (no executor) matching the request.
   * Same deterministic order as getTools.
   */
  list(request?: ToolRegistryRequest): ToolMetadata[];

  /** True if a tool with this exact name is registered. */
  has(name: string): boolean;
}

class ToolRegistryImpl implements ToolRegistry {
  private readonly _map = new Map<string, ToolDescriptor>();
  private readonly _order: string[] = [];

  register(descriptor: ToolDescriptor): void {
    const { name } = descriptor.metadata;
    if (this._map.has(name)) {
      throw new DuplicateToolError(name);
    }
    this._map.set(name, descriptor);
    this._order.push(name);
  }

  getTools(request: ToolRegistryRequest = {}): ToolDescriptor[] {
    this._validateNames(request.names);
    return this._filter(request).map((name) => this._map.get(name)!);
  }

  list(request: ToolRegistryRequest = {}): ToolMetadata[] {
    this._validateNames(request.names);
    return this._filter(request).map((name) => {
      const d = this._map.get(name)!;
      return {
        name: d.metadata.name,
        description: d.metadata.description,
        class: d.metadata.class,
        allowedPhases: [...d.metadata.allowedPhases],
        executionMode: d.metadata.executionMode,
        outputCapPolicy: { ...d.metadata.outputCapPolicy },
      };
    });
  }

  has(name: string): boolean {
    return this._map.has(name);
  }

  private _validateNames(names: readonly string[] | undefined): void {
    if (names === undefined) return;
    for (const name of names) {
      if (!this._map.has(name)) {
        throw new UnknownToolError(name);
      }
    }
  }

  private _filter(request: ToolRegistryRequest): string[] {
    const { phase, names } = request;

    if (names !== undefined && names.length === 0) {
      return [];
    }

    const nameSet = names !== undefined ? new Set(names) : undefined;

    return this._order.filter((name) => {
      if (nameSet !== undefined && !nameSet.has(name)) return false;
      if (phase !== undefined) {
        const descriptor = this._map.get(name)!;
        if (!descriptor.metadata.allowedPhases.includes(phase)) return false;
      }
      return true;
    });
  }
}

export function createToolRegistry(initialTools?: readonly ToolDescriptor[]): ToolRegistry {
  const registry = new ToolRegistryImpl();
  if (initialTools) {
    for (const tool of initialTools) {
      registry.register(tool);
    }
  }
  return registry;
}
