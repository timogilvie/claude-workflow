#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  listContextSpecPaths,
  resolveRepoDir,
} from '../shared/lib/context-tool.ts';
import {
  searchSubsystemSpecs,
  type SpecSnippetSearchResult,
} from '../shared/lib/subsystem-search.ts';

function formatSnippet(snippet: string, query: string): string {
  const queryLower = query.toLowerCase();
  const lines = snippet.split('\n');

  const formatted = lines.map((line) => {
    const lineLower = line.toLowerCase();
    const index = lineLower.indexOf(queryLower);

    if (index !== -1) {
      const before = line.substring(0, index);
      const match = line.substring(index, index + query.length);
      const after = line.substring(index + query.length);
      return `${before}**${match}**${after}`;
    }

    return line;
  });

  return formatted.join('\n');
}

function displayResults(results: SpecSnippetSearchResult[], query: string): void {
  if (results.length === 0) {
    console.log('');
    console.log(`No matches found for "${query}"`);
    console.log('');
    return;
  }

  console.log('');
  console.log(`Found ${results.length} match${results.length === 1 ? '' : 'es'} for "${query}"`);
  console.log('');

  results.forEach((result, index) => {
    // Add type label
    const typeLabel = result.specType === 'concept' ? '[concept]' : '[subsystem]';
    console.log(`${index + 1}. ${typeLabel} ${result.subsystemName} (${result.subsystemId})`);
    console.log(`   ${result.specPath}`);
    console.log('');

    result.snippets.forEach((snippet, snippetIndex) => {
      const location = result.matchLocations[snippetIndex];
      console.log(`   [${location}]`);
      const formatted = formatSnippet(snippet, query);
      formatted.split('\n').forEach((line) => {
        console.log(`   ${line}`);
      });
      console.log('');
    });
  });
}

async function main(
  query: string,
  repoDir: string,
  limit: number,
  sectionFilter: string | undefined,
) {
  const specFiles = listContextSpecPaths(repoDir);
  if (specFiles.length === 0) {
    throw new Error('No subsystem specs found in .wavemill/context/\nInitialize first: wavemill context init');
  }

  const results = searchSubsystemSpecs(query, repoDir, {
    limit,
    sectionFilter: sectionFilter || '',
  });
  displayResults(results, query);
}

runTool({
  name: 'context-search',
  description: 'Keyword search across subsystem specs and concept pages',
  options: {
    limit: { type: 'string', description: 'Max results to show (default: 10)' },
    section: { type: 'string', description: 'Search only in specific section' },
  },
  positional: {
    name: 'query repoPath',
    description: 'Search query and optional repository path',
    multiple: true,
  },
  examples: [
    'npx tsx tools/context-search.ts "linear api"',
    'npx tsx tools/context-search.ts "error handling" --limit 5',
    'npx tsx tools/context-search.ts "validation" --section "Architectural Constraints"',
  ],
  additionalHelp: `Performs case-insensitive substring matching across all subsystem specs and concept pages.
Returns ranked results with relevant snippets.`,
  async run({ args, positional }) {
    const query = positional[0];
    if (!query) {
      throw new Error('Search query is required');
    }

    const repoDir = resolveRepoDir(positional[1]);
    const limit = args.limit ? parseInt(args.limit, 10) : 10;
    await main(query, repoDir, limit, args.section);
  },
});
