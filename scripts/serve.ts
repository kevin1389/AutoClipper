/**
 * Production process supervisor: starts the Next.js server and the processing
 * worker together, so a deployment cannot come up with an idle queue.
 *
 *   npm run build && npm run start:all
 *
 * Both children share this process's environment (including AC_DATA_DIR and the
 * API keys), so they always point at the same database. If either dies the whole
 * supervisor exits non-zero, which is what a process manager should see.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { loadEnvFile } from '../src/lib/load-env';

loadEnvFile();

const port = process.env.PORT ?? '3000';
const hostname = process.env.HOSTNAME ?? '0.0.0.0';
const nextBin = path.join(process.cwd(), 'node_modules', '.bin', 'next');
const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');

const children: { name: string; child: ChildProcess }[] = [];
let shuttingDown = false;

function log(message: string): void {
  process.stdout.write(`[serve ${new Date().toISOString()}] ${message}\n`);
}

function start(name: string, command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'production' },
  });
  children.push({ name, child });
  child.on('error', (error) => {
    log(`${name} failed to start: ${error.message}`);
    void shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    log(`${name} exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
    void shutdown(code ?? 1);
  });
  log(`${name} started (pid ${child.pid})`);
  return child;
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { name, child } of children) {
    if (!child.killed) {
      log(`stopping ${name}`);
      child.kill('SIGTERM');
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGKILL');
  }
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

log(`starting worker + web server on ${hostname}:${port}`);
start('worker', tsxBin, ['worker/index.ts']);
start('web', nextBin, ['start', '--hostname', hostname, '--port', port]);
