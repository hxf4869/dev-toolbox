import { availableModels, type ProviderEntry } from './contracts'

describe('AI model availability', () => {
  it('allows text tasks without tool calling and still requires vision for image tasks', () => {
    const providers: ProviderEntry[] = [{
      id: 'provider',
      displayName: 'Provider',
      enabled: true,
      models: [
        {
          id: 'text', displayName: 'Text', modelId: 'text-model',
          contextWindow: 8192, maxOutputTokens: 1024,
          supportsTools: false, supportsVision: false, enabled: true,
        },
        {
          id: 'vision', displayName: 'Vision', modelId: 'vision-model',
          contextWindow: 8192, maxOutputTokens: 1024,
          supportsTools: false, supportsVision: true, enabled: true,
        },
      ],
    }]

    expect(availableModels(providers).map((model) => model.id)).toEqual(['text', 'vision'])
    expect(availableModels(providers, true).map((model) => model.id)).toEqual(['vision'])
  })
})
