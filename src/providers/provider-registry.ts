import type {
  ProviderId,
  ProviderRole,
  ProviderConfig,
  CoderProvider,
  ReviewerProvider,
} from './provider-types.js';

export interface RegistryEntry {
  id: ProviderId;
  role: ProviderRole;
  factory: (config: ProviderConfig) => CoderProvider | ReviewerProvider;
}

export class ProviderRegistry {
  private coders = new Map<ProviderId, (config: ProviderConfig) => CoderProvider>();
  private reviewers = new Map<ProviderId, (config: ProviderConfig) => ReviewerProvider>();

  registerCoder(id: ProviderId, factory: (config: ProviderConfig) => CoderProvider): void {
    this.coders.set(id, factory);
  }

  registerReviewer(id: ProviderId, factory: (config: ProviderConfig) => ReviewerProvider): void {
    this.reviewers.set(id, factory);
  }

  resolveCoder(config: ProviderConfig): CoderProvider {
    const factory = this.coders.get(config.provider);
    if (!factory) {
      throw new Error(`Unknown coder provider: ${config.provider}`);
    }
    return factory(config);
  }

  resolveReviewer(config: ProviderConfig): ReviewerProvider {
    const factory = this.reviewers.get(config.provider);
    if (!factory) {
      throw new Error(`Unknown reviewer provider: ${config.provider}`);
    }
    return factory(config);
  }

  hasCoder(id: ProviderId): boolean {
    return this.coders.has(id);
  }

  hasReviewer(id: ProviderId): boolean {
    return this.reviewers.has(id);
  }
}
