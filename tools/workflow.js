#!/usr/bin/env node

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const workflowPath = join(__dirname, 'prompts', 'workflow-prompt.md');
const workflow = readFileSync(workflowPath, 'utf-8');

console.log('='.repeat(60));
console.log('FEATURE IMPLEMENTATION WORKFLOW');
console.log('='.repeat(60));
console.log(workflow);
console.log('='.repeat(60));
console.log('\nReady to start the workflow? Follow the steps above.');