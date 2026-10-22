// Pre-recording checklist: is everything ready for the demo? Read-only, except one
// tiny model tool call to prove the configured coding agent can use Hamyar tools.
// Usage: npm run preflight -- [app]
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { LiaraClient } from '../core/liara-client.js';
import { llmFromEnv } from '../core/agent.js';
import { appUrl, probe } from '../core/deployer.js';

const app = process.argv[2] ?? 'broken-shop';
const client = LiaraClient.fromEnv();
let failures = 0;

function line(ok: boolean | 'warn', label: string, detail = '') {
  if (ok === false) failures++;
  console.log(`${ok === true ? '✅' : ok === 'warn' ? '⚠️ ' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function check(label: string, fn: () => Promise<[boolean | 'warn', string]>) {
  try {
    const [ok, detail] = await fn();
    line(ok, label, detail);
  } catch (err: any) {
    line(false, label, err?.explanation ?? err?.message ?? String(err));
  }
}

console.log(`\nHamyar demo preflight for "${app}"\n`);

await check('Liara API token', async () => {
  await client.me();
  return [true, 'accepted'];
});

await check('Account balance', async () => {
  const b = await client.balance();
  return [b > 0 ? true : false, `${Math.round(b).toLocaleString('fa-IR')} تومان${b > 0 ? '' : ' — charge the account'}`];
});

await check('AI model answers', async () => {
  const llm = llmFromEnv();
  if (!llm) return [false, 'set Liara AI, CodeCraft API, or another OpenAI-compatible provider'];
  const reply = await llm.chat(
    [{ role: 'user', content: 'Call hamyar_connection_check exactly once.' }],
    [{ name: 'hamyar_connection_check', description: 'Confirms that tool calling works.', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
  );
  const called = reply.tool_calls?.[0]?.function.name;
  return [called === 'hamyar_connection_check', `${llm.provider} · ${llm.model}${called ? ` called ${called}` : ' did not call the tool'}`];
});

await check(`App ${app} exists`, async () => {
  const info = await client.getApp(app);
  return [info.scale === 0 ? 'warn' : true, `${info.type}, plan ${info.planID}, ${info.status}${info.scale === 0 ? ' (turned off)' : ''}`];
});

await check(`App ${app} env`, async () => {
  const envs = ((await client.getApp(app)).envs ?? []).map((e: any) => e.key);
  const fault = ((await client.getApp(app)).envs ?? []).find((e: any) => e.key === 'FAULT')?.value;
  return [envs.includes('DATABASE_URL') ? true : 'warn', `DATABASE_URL ${envs.includes('DATABASE_URL') ? 'set' : 'missing (fine only for the missing-env scene)'}, FAULT=${fault || 'none'}`];
});

await check(`Site ${appUrl(app)} is healthy`, async () => {
  const p = await probe(appUrl(app), 3);
  return [p.healthy ? true : 'warn', `${Math.round(p.okRatio * 100)}% ok, p95 ${p.p95}ms`];
});

await check('Releases available for rollback', async () => {
  const r = await client.releases(app, 5);
  const ready = (r.releases ?? []).filter((x: any) => x.state === 'READY').length;
  return [ready >= 2 ? true : 'warn', `${ready} ready release(s)${ready < 2 ? ' — deploy twice before the rollback scene' : ''}`];
});

await check('Unit tests', async () => {
  const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vitest', 'run'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const summary = (res.stdout + res.stderr).match(/Tests\s+.*\(\d+\)/)?.[0]?.replace(/\x1b\[[0-9;]*m/g, '') ?? 'no summary';
  return [res.status === 0, summary];
});

line(process.env.HAMYAR_MODE !== 'auto-safe' ? true : 'warn', 'Safety mode', process.env.HAMYAR_MODE || 'review');

console.log(failures ? `\n${failures} blocking problem(s). Fix them before recording.\n` : '\nReady to record.\n');
process.exit(failures ? 1 : 0);
