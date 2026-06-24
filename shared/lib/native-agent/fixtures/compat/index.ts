import gitDiffOpenAiCompletionsFixture from './git_diff.openai-completions.fixture.ts';
import gitDiffOpenAiResponsesFixture from './git_diff.openai-responses.fixture.ts';
import gitStatusOpenAiCompletionsFixture from './git_status.openai-completions.fixture.ts';
import gitStatusOpenAiResponsesFixture from './git_status.openai-responses.fixture.ts';
import listFilesOpenAiCompletionsFixture from './list_files.openai-completions.fixture.ts';
import listFilesOpenAiResponsesFixture from './list_files.openai-responses.fixture.ts';
import readFileOpenAiCompletionsFixture from './read_file.openai-completions.fixture.ts';
import readFileOpenAiResponsesFixture from './read_file.openai-responses.fixture.ts';
import searchTextOpenAiCompletionsFixture from './search_text.openai-completions.fixture.ts';
import searchTextOpenAiResponsesFixture from './search_text.openai-responses.fixture.ts';
import type { NativeProviderName, PiTransportKind } from '../../../model-registry.ts';
import type { NativeToolCall } from '../../provider.ts';

export interface ToolCompatFixture {
  tool: string;
  transport: PiTransportKind;
  modelId: string;
  nativeProvider: NativeProviderName;
  toolDescriptor: {
    name: string;
    description: string;
    parameters: unknown;
  };
  request: {
    invocationArgs: Record<string, unknown>;
    expectedPayload: unknown;
  };
  response: {
    rawProviderResponse: unknown;
    expectedToolCall: NativeToolCall;
  };
}

const FIXTURES: readonly ToolCompatFixture[] = [
  readFileOpenAiCompletionsFixture,
  readFileOpenAiResponsesFixture,
  listFilesOpenAiCompletionsFixture,
  listFilesOpenAiResponsesFixture,
  searchTextOpenAiCompletionsFixture,
  searchTextOpenAiResponsesFixture,
  gitStatusOpenAiCompletionsFixture,
  gitStatusOpenAiResponsesFixture,
  gitDiffOpenAiCompletionsFixture,
  gitDiffOpenAiResponsesFixture,
];

export function getToolCompatFixtures(): ToolCompatFixture[] {
  return [...FIXTURES];
}

export function findFixture(tool: string, transport: PiTransportKind): ToolCompatFixture | undefined {
  return FIXTURES.find((fixture) => fixture.tool === tool && fixture.transport === transport);
}
