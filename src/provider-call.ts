export type ProviderRole = 'coder' | 'reviewer';

export interface ProviderCallInput {
  role: ProviderRole;
  prompt: string;
  model: string;
  provider: string;
}

export interface ProviderCallResult {
  role: ProviderRole;
  text: string;
  provider: string;
  model: string;
}

export type ProviderCallFn = (input: ProviderCallInput) => Promise<ProviderCallResult>;

export function buildProviderCallInput(
  role: string,
  prompt: string,
  provider: string,
  model: string
): ProviderCallInput {
  if (role !== 'coder' && role !== 'reviewer') {
    throw new Error('Invalid role: expected coder or reviewer');
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('Invalid prompt: expected non-empty string');
  }
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error('Invalid provider: expected non-empty string');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('Invalid model: expected non-empty string');
  }
  return { role, prompt, provider, model };
}

export function createMockProviderCall(responseText: string): ProviderCallFn {
  return async (input: ProviderCallInput): Promise<ProviderCallResult> => {
    return {
      role: input.role,
      text: responseText,
      provider: input.provider,
      model: input.model,
    };
  };
}

export function createRealProviderCall(): ProviderCallFn {
  return async (): Promise<ProviderCallResult> => {
    throw new Error('real provider call is not implemented yet');
  };
}
