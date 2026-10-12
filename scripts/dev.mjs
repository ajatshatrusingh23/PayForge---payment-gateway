#!/usr/bin/env node
/**
 * Runs the whole platform locally in one terminal:
 *   9 backend services (built with `nest build --all`), the hosted checkout (Vite),
 *   the dashboard (Next.js) and the demo store, all with coloured, prefixed logs.
 * Infrastructure must already be up: `npm run infra:up`.
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skipBuild = process.argv.includes('--no-build');

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

for (const [name, port] of [['Postgres', 55432], ['Redis', 6379], ['Kafka (Redpanda)', 19092]]) {
  if (!(await portOpen(port))) {
    console.error(`✘ ${name} is not reachable on localhost:${port}. Start infrastructure first: npm run infra:up`);
    process.exit(1);
  }
}

if (!skipBuild || !existsSync(join(root, 'backend/dist/apps/gateway/main.js'))) {
  console.log('▸ Building backend services…');
  execSync('npm run build', { cwd: join(root, 'backend'), stdio: 'inherit' });
}
if (!existsSync(join(root, 'sdk/payforge-js/dist/payforge.umd.cjs'))) {
  execSync('npm run build', { cwd: join(root, 'sdk/payforge-js'), stdio: 'inherit' });
}

const processes = [
  { name: 'backend', cwd: 'backend', cmd: 'node', args: ['scripts/start-all.mjs'], color: 36 },
  { name: 'checkout', cwd: 'web/checkout', cmd: 'npx', args: ['vite', '--port', '5174', '--strictPort'], color: 35 },
  { name: 'dashboard', cwd: 'web/dashboard', cmd: 'npx', args: ['next', 'dev', '-p', '3001'], color: 33 },
];
if (existsSync(join(root, 'web/demo-store/.env'))) {
  processes.push({ name: 'store', cwd: 'web/demo-store', cmd: 'node', args: ['--watch', 'server.mjs'], color: 32 });
} else {
  console.log('ℹ Demo store skipped: run `npm run seed` (with the backend up) to create its .env, then restart.');
}

const width = Math.max(...processes.map((p) => p.name.length));
const children = processes.map((p) => {
  const child = spawn(p.cmd, p.args, { cwd: join(root, p.cwd), env: { ...process.env, FORCE_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${p.color}m${p.name.padEnd(width)}\x1b[0m ┃ `;
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
  }
  child.on('exit', (code) => process.stdout.write(`${prefix}exited (${code})\n`));
  return child;
});

console.log(`
  API gateway   http://localhost:8080
  Dashboard     http://localhost:3001   (demo@chaicart.in / chaicart-demo-123 after seeding)
  Demo store    http://localhost:3000
  Checkout      http://localhost:5174
  Swagger       http://localhost:4002/docs (payments), :4001/docs, :4003/docs …
`);

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 2500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
