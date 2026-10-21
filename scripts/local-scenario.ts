// Runs the Broken Shop locally with a real fault, sends real traffic, feeds its
// real stdout/stderr into the SRE engine and prints the board. No Liara needed:
// this checks the detectors against genuine app output, not hand-written fixtures.
// Usage: npm run scenario -- <missing_env|memory_leak|slow|bad_release|healthy>
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { probe } from '../core/deployer.js';
import { scanEnv } from '../core/env-scan.js';
import { boardFromSnapshot, renderBoard } from '../core/sre/diagnose.js';
import type { Snapshot } from '../core/sre/snapshot.js';

const scenario = process.argv[2] ?? 'healthy';
const PORT = 3199;
const dir = join(import.meta.dirname, '..', 'demo-app');
const env: Record<string, string> = { ...process.env, PORT: String(PORT) } as any;
if (scenario !== 'missing_env') env.DATABASE_URL = 'postgres://shop:local-pass@localhost:5432/shop';
if (['memory_leak', 'slow', 'bad_release'].includes(scenario)) env.FAULT = scenario;

const logs: Snapshot['logs'] = [];
const memory: Snapshot['memoryBytes'] = [];
const started = Date.now();
const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
const collect = (type: string) => (chunk: Buffer) => {
  // an error log and its stack trace arrive as one chunk; keep them together like Liara does
  for (const block of chunk.toString().split(/\n(?=\S)/)) if (block.trim()) logs.push({ at: Date.now(), message: block.trimEnd(), type });
};
child.stdout.on('data', collect('stdout'));
child.stderr.on('data', collect('stderr'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(1000);

// 20 seconds of traffic; memory is read from the app's own [mem] lines (rss).
const path = scenario === 'slow' ? '/products' : '/';
for (let i = 0; i < 20; i++) {
  await Promise.all([fetch(`http://localhost:${PORT}${path}`).catch(() => {}), fetch(`http://localhost:${PORT}/health`).catch(() => {})]);
  const rss = [...logs].reverse().find((l) => l.message.includes('[mem] rss='))?.message.match(/rss=(\d+)MB/);
  if (rss) memory.push({ t: Date.now(), v: Number(rss[1]) * 1024 * 1024 });
  await sleep(scenario === 'slow' ? 0 : 200);
}
const probed = await probe(`http://localhost:${PORT}${path}`, 5);
child.kill();

const snapshot: Snapshot = {
  app: `broken-shop (local, ${scenario})`,
  collectedAt: Date.now(),
  windowStart: started - 60_000,
  // memory_leak runs on a deliberately small 256 MB "plan" so the leak is visible in 20 s
  appInfo: { status: 'RUNNING', scale: 1, planID: 'local', planRamGB: scenario === 'memory_leak' ? 0.25 : 0.5, planCpu: 0.5, envNames: scenario === 'missing_env' ? [] : ['DATABASE_URL'], platform: 'node' },
  releases: [
    { id: 'local-2', state: 'READY', createdAt: started, port: PORT },
    { id: 'local-1', state: 'READY', createdAt: started - 3600_000, port: PORT },
  ],
  currentReleaseId: 'local-2',
  logs: scenario === 'bad_release' ? [{ at: started - 120_000, message: 'GET / 200 4ms' }, ...logs] : logs,
  events: [],
  applets: [],
  memoryBytes: memory,
  cpuCores: [],
  disks: [],
  probe: { ...probed, url: `http://localhost:${PORT}${path}` },
  codeEnv: scanEnv(dir, scenario === 'missing_env' ? [] : ['DATABASE_URL']),
  gaps: ['local run: no CPU metrics and no Liara events'],
};

console.log(renderBoard(boardFromSnapshot(snapshot)));
