// Read-only smoke test of the Liara API. Makes GET requests only; changes nothing.
import 'dotenv/config';

const BASE = process.env.LIARA_API_BASE || 'https://api.liara.ir';
const TOKEN = process.env.LIARA_API_TOKEN;
const TEAM = process.env.LIARA_TEAM_ID;

if (!TOKEN) {
  console.error('LIARA_API_TOKEN is empty. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

async function get(path: string): Promise<{ status: number; data: any }> {
  const url = new URL(path, BASE);
  if (TEAM) url.searchParams.set('teamID', TEAM);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data };
}

function line(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(28)} ${detail}`);
}

async function main() {
  const me = await get('/v1/me');
  line('GET /v1/me', me.status === 200, `status ${me.status}`);
  if (me.status === 401) {
    console.error('Token rejected (401). Create a new key in the Liara console.');
    process.exit(1);
  }

  const appPlans = me.data?.plans?.projects ?? {};
  const planIds = Object.keys(appPlans);
  line('plans.projects', planIds.length > 0, `${planIds.length} app plans`);
  for (const id of planIds) {
    const p = appPlans[id];
    console.log(`        - ${id}: ${JSON.stringify(p).slice(0, 160)}`);
  }

  const billing = await get('/v1/billing');
  line('GET /v1/billing', billing.status === 200, `status ${billing.status}, keys: ${Object.keys(billing.data ?? {}).join(', ')}`);

  const projects = await get('/v1/projects');
  const list: any[] = projects.data?.projects ?? [];
  line('GET /v1/projects', projects.status === 200, `${list.length} apps`);
  for (const p of list) {
    console.log(`        - ${p.project_id} (${p.type}, ${p.planID}, ${p.status}, scale=${p.scale})`);
  }

  // Probe the undocumented plans endpoint used by community tools.
  const plans = await get('/v1/plans?type=app');
  line('GET /v1/plans (undocumented)', plans.status === 200, `status ${plans.status}`);

  // Per-app read endpoints, on the first app if there is one.
  const app = list[0]?.project_id;
  if (!app) {
    console.log('\nNo apps yet: per-app endpoints (logs, metrics, releases) will be checked after the first deploy.');
    return;
  }
  const since = Math.floor(Date.now() / 1000) - 3600;
  const checks: [string, string][] = [
    ['details', `/v1/projects/${app}`],
    ['releases', `/v1/projects/${app}/releases?page=1&count=5`],
    ['logs', `/v1/projects/${app}/logs?since=${since}`],
    ['events', `/v1/projects/${app}/events`],
    ['applets', `/v1/projects/${app}/applets`],
    ['metrics/summary', `/v1/projects/${app}/metrics/summary`],
    ['metrics/memory', `/v1/projects/${app}/metrics/memory?since=${since}`],
    ['domains', `/v1/domains?project=${app}`],
  ];
  console.log(`\nPer-app checks on "${app}":`);
  for (const [name, path] of checks) {
    const r = await get(path);
    const shape = typeof r.data === 'object' && r.data ? Object.keys(r.data).slice(0, 6).join(', ') : String(r.data).slice(0, 80);
    line(name, r.status === 200, `status ${r.status}, shape: ${shape}`);
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err.message);
  process.exit(1);
});
