#!/usr/bin/env node
// One-time setup: installs every package and builds what the dev runner needs.
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['backend', 'sdk/payforge-js', 'web/checkout', 'web/dashboard', 'web/demo-store'];

const run = (cmd, cwd) => {
  console.log(`\n\x1b[36m▸ ${cmd}\x1b[0m  (${cwd.replace(root + '/', '') || '.'})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`Node ${process.versions.node} detected; PayForge needs Node 20 or newer.`);
  process.exit(1);
}

for (const pkg of packages) run('npm install --no-audit --no-fund', join(root, pkg));
run('npm run build', join(root, 'sdk/payforge-js'));
run('npm run build', join(root, 'backend'));

console.log(`
\x1b[32m✔ Setup complete.\x1b[0m Next:
  npm run infra:up     # Postgres, Redis, Redpanda (Kafka) in Docker
  npm run dev          # all services + checkout + dashboard + demo store
  npm run seed:data    # demo merchant, sample payments, wires up the demo store
`);
