// Operator controls for recording the demo: break and repair the Broken Shop on Liara.
// These are the presenter's own commands (not the agent's), so they act directly.
//
//   npm run demo -- fault <app> <none|memory_leak|slow>   switch the FAULT env var
//   npm run demo -- unset-db <app>                         remove DATABASE_URL (missing-env scenario)
//   npm run demo -- set-db <app>                           put a demo DATABASE_URL back
//   npm run demo -- bad-release <app>                      deploy a version with a real bug in the code
//   npm run demo -- good-release <app>                     deploy the clean demo app
//   npm run demo -- load <app> [rps] [seconds]             send traffic so logs and metrics move
import 'dotenv/config';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiaraClient } from '../core/liara-client.js';
import { envDiff } from '../core/actions.js';
import { appUrl, deploySource } from '../core/deployer.js';
import { detectProject } from '../core/detect.js';

process.on('uncaughtException', (err: any) => {
  console.error(`❌ ${err?.explanation ?? err?.message ?? err}`);
  process.exit(1);
});

const DEMO_DIR = join(import.meta.dirname, '..', 'demo-app');
const DEMO_DB_URL = 'postgres://shop:demo-password@demo-db:5432/shop';
const [command, app, ...rest] = process.argv.slice(2);
const client = LiaraClient.fromEnv();

if (!command || !app) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(3, 9).join('\n').replace(/\/\/ ?/g, ''));
  process.exit(1);
}

async function setEnv(updates: { key: string; value: string }[], remove: string[] = []) {
  const current = ((await client.getApp(app)).envs ?? []).filter((e: any) => !remove.includes(e.key));
  const d = envDiff(current, updates);
  await client.updateEnvs(app, d.merged);
  console.log(`env updated on ${app}: added [${d.added}] changed [${d.changed}] removed [${remove}] — Liara restarts the app.`);
}

async function deploy(dir: string, message: string) {
  const d = detectProject(dir);
  const result = await deploySource(client, { app, dir, platform: d.platform, port: d.port, message }, (e) =>
    console.log(`  ${e.phase}${e.message ? ` (${e.message})` : ''}${e.line ? `: ${e.line.slice(0, 100)}` : ''}`),
  );
  const v = result.verification;
  console.log(`release ${result.releaseID}: ${result.state}${v ? `, ok ${Math.round(v.okRatio * 100)}% p95 ${v.p95}ms${v.reason ? ` — ${v.reason}` : ''}` : ''}`);
}

switch (command) {
  case 'fault': {
    const fault = rest[0] ?? 'none';
    if (!['none', 'memory_leak', 'slow'].includes(fault)) throw new Error('fault must be none, memory_leak or slow');
    await setEnv([{ key: 'FAULT', value: fault === 'none' ? '' : fault }]);
    break;
  }
  case 'unset-db':
    await setEnv([], ['DATABASE_URL']);
    break;
  case 'set-db':
    await setEnv([{ key: 'DATABASE_URL', value: DEMO_DB_URL }]);
    break;
  case 'bad-release': {
    // A real code bug in a real release, so Hamyar sees a new release followed by errors.
    const dir = mkdtempSync(join(tmpdir(), 'broken-shop-v2-'));
    cpSync(DEMO_DIR, dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
    const server = join(dir, 'server.js');
    const code = readFileSync(server, 'utf8');
    const patched = code.replace("faults.has('bad_release') ? rows.find((p) => p.id === 999) : rows[0]", 'rows.find((p) => p.id === 999)');
    if (patched === code) throw new Error('could not inject the bug: server.js changed');
    writeFileSync(server, patched);
    try {
      await deploy(dir, 'v2: new featured-product banner');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    break;
  }
  case 'good-release':
    await deploy(DEMO_DIR, 'clean Broken Shop');
    break;
  case 'load': {
    const rps = Number(rest[0] ?? 5);
    const seconds = Number(rest[1] ?? 60);
    const paths = ['/', '/products', '/health'];
    let sent = 0;
    let failed = 0;
    console.log(`sending ${rps} req/s to ${appUrl(app)} for ${seconds}s…`);
    const timer = setInterval(() => {
      for (let i = 0; i < rps; i++) {
        const path = paths[sent++ % paths.length];
        fetch(appUrl(app) + path, { signal: AbortSignal.timeout(15_000) })
          .then((r) => { if (r.status >= 500) failed++; })
          .catch(() => failed++);
      }
    }, 1000);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    clearInterval(timer);
    console.log(`sent=${sent} failed=${failed}`);
    break;
  }
  default:
    console.error(`unknown command: ${command}`);
    process.exit(1);
}
