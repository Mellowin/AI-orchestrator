export interface AIClient {
  generate(prompt: string): Promise<string>;
}

export class MockAIClient implements AIClient {
  constructor(private readonly response: string) {}

  async generate(prompt: string): Promise<string> {
    if (prompt.trim().length === 0) {
      throw new Error('Prompt is empty');
    }
    return this.response;
  }
}

export function createMockAIClient(response: string): AIClient {
  return new MockAIClient(response);
}
