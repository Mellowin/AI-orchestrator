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
