import { ProviderType, LLMProvider, ProviderConfig } from '../../foundations/contracts/llm.js';

export const GLM_MODEL_MAP: Record<string, string> = {
  haiku: 'glm-4.5-air',
  sonnet: 'glm-4.7',
  opus: 'glm-5.1',
};

export async function createProvider(config: ProviderConfig): Promise<LLMProvider> {
  switch (config.type) {
    case 'openai': {
      const { OpenAIProvider } = await import('./openai.js');
      return new OpenAIProvider(config.apiKey, config.model, 'https://api.openai.com/v1');
    }
    case 'openai-compatible': {
      const { OpenAIProvider } = await import('./openai.js');
      return new OpenAIProvider(config.apiKey, config.model, config.baseUrl);
    }
    case 'anthropic': {
      const { AnthropicProvider } = await import('./anthropic.js');
      return new AnthropicProvider(config.apiKey, config.model);
    }
    case 'glm': {
      const { AnthropicProvider } = await import('./anthropic.js');
      return new AnthropicProvider(
        config.apiKey,
        GLM_MODEL_MAP[config.model] || config.model,
        { baseURL: 'https://api.z.ai/api/anthropic', timeout: 3000000 },
      );
    }
  }
}
