import { createReadOnlyTools } from '../../tools/read-only.ts';

const tool = createReadOnlyTools('/tmp/wavemill-compat-fixtures').find(
  (descriptor) => descriptor.metadata.name === 'read_file',
);

if (!tool) {
  throw new Error('Missing read_file tool descriptor');
}

export default {
  tool: 'read_file',
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
      path: 'package.json',
      startLine: 1,
      maxLines: 20,
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
      {
        type: 'response.created',
        response: { id: 'resp_read_file' },
      },
      {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'fc_read_file',
          call_id: 'call_read_file',
          name: 'read_file',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.done',
        arguments: '{"path":"package.json","startLine":1,"maxLines":20}',
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_read_file',
          call_id: 'call_read_file',
          name: 'read_file',
          arguments: '{"path":"package.json","startLine":1,"maxLines":20}',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_read_file',
          status: 'completed',
          usage: {
            input_tokens: 10,
            output_tokens: 6,
            total_tokens: 16,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
      '[DONE]',
    ],
    expectedToolCall: {
      id: 'call_read_file|fc_read_file',
      name: 'read_file',
      arguments: {
        path: 'package.json',
        startLine: 1,
        maxLines: 20,
      },
    },
  },
} as const;
