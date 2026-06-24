import { createGitTools } from '../../tools/git.ts';

const tool = createGitTools('/tmp/wavemill-compat-fixtures').find(
  (descriptor) => descriptor.metadata.name === 'git_status',
);

if (!tool) {
  throw new Error('Missing git_status tool descriptor');
}

export default {
  tool: 'git_status',
  transport: 'openai-responses',
  modelId: 'gpt-4o',
  nativeProvider: 'openai',
  toolDescriptor: {
    name: tool.metadata.name,
    description: tool.metadata.description,
    parameters: tool.parameters,
  },
  request: {
    invocationArgs: {},
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
      { type: 'response.created', response: { id: 'resp_git_status' } },
      {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'fc_git_status',
          call_id: 'call_git_status',
          name: 'git_status',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.done',
        arguments: '{}',
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_git_status',
          call_id: 'call_git_status',
          name: 'git_status',
          arguments: '{}',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_git_status',
          status: 'completed',
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            total_tokens: 13,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
      '[DONE]',
    ],
    expectedToolCall: {
      id: 'call_git_status|fc_git_status',
      name: 'git_status',
      arguments: {},
    },
  },
} as const;
