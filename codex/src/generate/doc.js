import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { renderTemplate } from '../templates.js';

const ensureDir = (path) => {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

export const generateDocFromTemplate = ({ template, output, replacements }) => {
  const content = renderTemplate(template, replacements);
  const outPath = resolve(output);
  ensureDir(outPath);
  writeFileSync(outPath, content);
  return outPath;
};
