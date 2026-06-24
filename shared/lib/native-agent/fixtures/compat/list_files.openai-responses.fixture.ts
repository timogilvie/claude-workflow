import { createReadOnlyTools } from '../../tools/read-only.ts';

const tool = createReadOnlyTools('/tmp/wavemill-compat-fixtures').find(
  (descriptor) => descriptor.metadata.name === 'list_files',
);

if (!tool) {
  throw new Error('Missing list_files tool descriptor');
}

export default {
  tool: 'list_files',
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
      path: 'shared/lib/native-agent',
      glob: '**/*.ts',
      maxResults: 25,
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
      { type: 'response.created', response: { id: 'resp_list_files' } },
      {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'fc_list_files',
          call_id: 'call_list_files',
          name: 'list_files',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.done',
        arguments: '{"path":"shared/lib/native-agent","glob":"**/*.ts","maxResults":25}',
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_list_files',
          call_id: 'call_list_files',
          name: 'list_files',
          arguments: '{"path":"shared/lib/native-agent","glob":"**/*.ts","maxResults":25}',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_list_files',
          status: 'completed',
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            total_tokens: 18,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
      '[DONE]',
    ],
    expectedToolCall: {
      id: 'call_list_files|fc_list_files',
      name: 'list_files',
      arguments: {
        path: 'shared/lib/native-agent',
        glob: '**/*.ts',
        maxResults: 25,
      },
    },
  },
} as const;
