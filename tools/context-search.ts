#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  searchSubsystemSpecs,
  type SpecSnippetSearchResult,
} from '../shared/lib/subsystem-search.ts';

/**
 * Format a snippet for display.
 */
function formatSnippet(snippet: string, query: string): string {
  // Highlight query matches (simple approach: uppercase the match)
  const queryLower = query.toLowerCase();
  const lines = snippet.split('\n');

  const formatted = lines.map(line => {
    const lineLower = line.toLowerCase();
    const index = lineLower.indexOf(queryLower);

    if (index !== -1) {
      // Highlight the match
      const before = line.substring(0, index);
      const match = line.substring(index, index + query.length);
      const after = line.substring(index + query.length);
      return `${before}**${match}**${after}`;
    }

    return line;
  });

  return formatted.join('\n');
}

/**
 * Display search results.
 */
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
    console.log(`${index + 1}. ${result.subsystemName} (${result.subsystemId})`);
    console.log(`   ${result.specPath}`);
    console.log('');

    result.snippets.forEach((snippet, i) => {
      const location = result.matchLocations[i];
      console.log(`   [${location}]`);
      const formatted = formatSnippet(snippet, query);
      formatted.split('\n').forEach(line => {
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
  sectionFilter: string | undefined
) {
  const contextDir = join(repoDir, '.wavemill', 'context');

  // Check if context directory exists
  if (!existsSync(contextDir)) {
    console.error('Error: No subsystem specs found');
    console.error('Initialize first: wavemill context init');
    process.exit(1);
  }

  const specFiles = readdirSync(contextDir).filter((file) => file.endsWith('.md'));
  if (specFiles.length === 0) {
    console.error('Error: No subsystem specs found in .wavemill/context/');
    console.error('Initialize first: wavemill context init');
    process.exit(1);
  }

  const results = searchSubsystemSpecs(query, repoDir, {
    limit,
    sectionFilter: sectionFilter || '',
  });
  displayResults(results, query);
}

runTool({
  name: 'context-search',
  description: 'Keyword search across subsystem specs',
  options: {
    limit: { type: 'string', description: 'Max results to show (default: 10)' },
    section: { type: 'string', description: 'Search only in specific section' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
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
  additionalHelp: `Performs case-insensitive substring matching across all subsystem specs.
Returns ranked results with relevant snippets.`,
  async run({ args, positional }) {
    const query = positional[0];
    if (!query) {
      console.error('Error: Search query is required');
      process.exit(1);
    }
    const repoPath = positional[1] || process.cwd();
    const repoDir = resolve(repoPath);
    const limit = args.limit ? parseInt(args.limit, 10) : 10;
    await main(query, repoDir, limit, args.section);
  },
});
