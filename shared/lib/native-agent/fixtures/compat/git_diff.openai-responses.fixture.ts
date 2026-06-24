import { createGitTools } from '../../tools/git.ts';

const tool = createGitTools('/tmp/wavemill-compat-fixtures').find(
  (descriptor) => descriptor.metadata.name === 'git_diff',
);

if (!tool) {
  throw new Error('Missing git_diff tool descriptor');
}

export default {
  tool: 'git_diff',
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
      base: 'HEAD',
      path: 'shared/lib/native-agent/loop.ts',
      maxBytes: 4096,
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
      { type: 'response.created', response: { id: 'resp_git_diff' } },
      {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'fc_git_diff',
          call_id: 'call_git_diff',
          name: 'git_diff',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.done',
        arguments: '{"base":"HEAD","path":"shared/lib/native-agent/loop.ts","maxBytes":4096}',
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_git_diff',
          call_id: 'call_git_diff',
          name: 'git_diff',
          arguments: '{"base":"HEAD","path":"shared/lib/native-agent/loop.ts","maxBytes":4096}',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_git_diff',
          status: 'completed',
          usage: {
            input_tokens: 11,
            output_tokens: 6,
            total_tokens: 17,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
      '[DONE]',
    ],
    expectedToolCall: {
      id: 'call_git_diff|fc_git_diff',
      name: 'git_diff',
      arguments: {
        base: 'HEAD',
        path: 'shared/lib/native-agent/loop.ts',
        maxBytes: 4096,
      },
    },
  },
} as const;
