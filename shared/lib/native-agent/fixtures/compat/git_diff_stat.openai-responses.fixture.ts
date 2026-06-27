import { createGitTools } from '../../tools/git.ts';

const tool = createGitTools('/tmp/wavemill-compat-fixtures').find(
  (descriptor) => descriptor.metadata.name === 'git_diff_stat',
);

if (!tool) {
  throw new Error('Missing git_diff_stat tool descriptor');
}

export default {
  tool: 'git_diff_stat',
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
      path: 'shared/lib/native-agent/tools/git.ts',
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
      { type: 'response.created', response: { id: 'resp_git_diff_stat' } },
      {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'fc_git_diff_stat',
          call_id: 'call_git_diff_stat',
          name: 'git_diff_stat',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.done',
        arguments: '{"base":"HEAD","path":"shared/lib/native-agent/tools/git.ts"}',
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_git_diff_stat',
          call_id: 'call_git_diff_stat',
          name: 'git_diff_stat',
          arguments: '{"base":"HEAD","path":"shared/lib/native-agent/tools/git.ts"}',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_git_diff_stat',
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
      id: 'call_git_diff_stat|fc_git_diff_stat',
      name: 'git_diff_stat',
      arguments: {
        base: 'HEAD',
        path: 'shared/lib/native-agent/tools/git.ts',
      },
    },
  },
} as const;
