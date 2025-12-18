import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve('.');
const TEMPLATES_DIR = join(ROOT, 'tools', 'prompts');

export const loadTemplate = (filename) => {
  const path = join(TEMPLATES_DIR, filename);
  if (!existsSync(path)) {
    throw new Error(`Template not found: ${path}`);
  }
  return readFileSync(path, 'utf-8');
};

export const renderTemplate = (filename, replacements) => {
  let content = loadTemplate(filename);
  Object.entries(replacements || {}).forEach(([key, value]) => {
    const token = new RegExp(`{{${key}}}`, 'g');
    content = content.replace(token, value);
  });
  return content;
};
