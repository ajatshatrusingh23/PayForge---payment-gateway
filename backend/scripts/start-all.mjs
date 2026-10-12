#!/usr/bin/env node
// Runs every built PayForge service in one terminal with coloured, prefixed logs.
// Usage: node scripts/start-all.mjs [service ...]   (default: all services)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SERVICES = [
  ['bank-simulator', 4009],
  ['merchant', 4001],
  ['vault', 4003],
  ['risk', 4004],
  ['ledger', 4005],
  ['webhook', 4006],
  ['settlement', 4007],
  ['payment', 4002],
  ['gateway', 8080],
];
const COLORS = [36, 33, 35, 32, 34, 91, 92, 93, 96];

const wanted = process.argv.slice(2);
const selected = SERVICES.filter(([name]) => !wanted.length || wanted.includes(name));
const width = Math.max(...selected.map(([n]) => n.length));
const children = [];
let shuttingDown = false;

for (const [i, [name, port]] of selected.entries()) {
  const entry = join(root, 'dist', 'apps', name, 'main.js');
  if (!existsSync(entry)) {
    console.error(`Missing ${entry}. Run "npm run build" in backend/ first.`);
    process.exit(1);
  }
  const color = COLORS[i % COLORS.length];
  const prefix = `\x1b[${color}m${name.padEnd(width)}\x1b[0m │ `;
  const child = spawn(process.execPath, ['--enable-source-maps', '--disable-warning=TimeoutNegativeWarning', entry], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!shuttingDown) console.error(`${prefix}exited with code ${code}`);
  });
  children.push(child);
}

const shutdown = () => {
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
