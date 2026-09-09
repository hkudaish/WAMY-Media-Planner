'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');
const autoprefixer = require('autoprefixer');

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'code_artifact.html');
const outputDir = path.join(root, 'dist');

(async () => {
  const html = await fs.readFile(sourcePath, 'utf8');
  const match = html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find the application JSX in code_artifact.html.');

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(path.join(outputDir, 'assets'), { recursive: true });

  const entry = [
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    'const ReactDOM = { createRoot };',
    match[1]
  ].join('\n');

  await esbuild.build({
    stdin: { contents: entry, loader: 'jsx', resolveDir: root, sourcefile: 'app.jsx' },
    bundle: true,
    minify: true,
    legalComments: 'none',
    outfile: path.join(outputDir, 'assets', 'app.js'),
    platform: 'browser',
    target: ['es2020'],
    define: { 'process.env.NODE_ENV': '"production"' }
  });

  const css = await postcss([
    tailwindcss({
      content: [{ raw: html, extension: 'html' }],
      theme: {
        extend: {
          colors: {
            wamy: { 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 950: '#172554' },
            imaan: { 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 950: '#022c22' }
          },
          fontFamily: { cairo: ['Cairo', 'system-ui', 'sans-serif'] }
        }
      }
    }),
    autoprefixer
  ]).process('@tailwind base;\n@tailwind components;\n@tailwind utilities;', { from: undefined });
  await fs.writeFile(path.join(outputDir, 'assets', 'app.css'), css.css);

  let productionHtml = html
    .replace(/\s*<!-- Tailwind \(Play CDN\)[\s\S]*?<\/script>\s*/, '\n')
    .replace(/\s*<script>\s*tailwind\.config\s*=\s*\{[\s\S]*?<\/script>\s*/, '\n')
    .replace(/\s*<!-- Exact pinned versions:[\s\S]*?<script src="https:\/\/unpkg\.com\/@babel\/standalone[^>]*><\/script>\s*/, '\n')
    .replace(match[0], '<script defer src="/assets/app.js"></script>')
    .replace('</head>', '    <link rel="stylesheet" href="/assets/app.css">\n</head>');
  await fs.writeFile(path.join(outputDir, 'index.html'), productionHtml);
  console.log('Production frontend built in dist/.');
})().catch(error => {
  console.error('Build failed:', error.message);
  process.exit(1);
});
