import { createReadOnlyTools } from '../../tools/read-only.ts';

const tool = createReadOnlyTools('/tmp/wavemill-compat-fixtures').find(
  (descriptor) => descriptor.metadata.name === 'search_text',
);

if (!tool) {
  throw new Error('Missing search_text tool descriptor');
}

export default {
  tool: 'search_text',
  transport: 'openai-responses',
  modelId: 'gpt-4o',
  nativeProvider: 'openai',
  toolDescriptor: {
    name: tool.metadata.name,
    description: tool.metadata.description,
    parameters: tool.parameters,
  },
  request: {
    invocationArgs: {
      query: 'runWavemillLoop',
      path: 'shared/lib/native-agent',
      glob: '**/*.ts',
      caseSensitive: true,
      maxResults: 10,
    },
    expectedPayload: {
      model: 'openai:gpt-4o',
      input: [
        { role: 'system', content: 'You are a fixture harness.' },
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Use the available tool.' }],
        },
      ],
      stream: true,
      store: false,
      tools: [
        {
          type: 'function',
          name: tool.metadata.name,
          description: tool.metadata.description,
          parameters: tool.parameters,
          strict: false,
        },
      ],
    },
  },
  response: {
    rawProviderResponse: [
      { type: 'response.created', response: { id: 'resp_search_text' } },
      {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'fc_search_text',
          call_id: 'call_search_text',
          name: 'search_text',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.done',
        arguments: '{"query":"runWavemillLoop","path":"shared/lib/native-agent","glob":"**/*.ts","caseSensitive":true,"maxResults":10}',
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_search_text',
          call_id: 'call_search_text',
          name: 'search_text',
          arguments: '{"query":"runWavemillLoop","path":"shared/lib/native-agent","glob":"**/*.ts","caseSensitive":true,"maxResults":10}',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_search_text',
          status: 'completed',
          usage: {
            input_tokens: 12,
            output_tokens: 8,
            total_tokens: 20,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
      '[DONE]',
    ],
    expectedToolCall: {
      id: 'call_search_text|fc_search_text',
      name: 'search_text',
      arguments: {
        query: 'runWavemillLoop',
        path: 'shared/lib/native-agent',
        glob: '**/*.ts',
        caseSensitive: true,
        maxResults: 10,
      },
    },
  },
} as const;
