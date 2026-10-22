// Trusted terminal channel for approvals filed by the MCP server or the dashboard.
//   npm run approve              list pending requests
//   npm run approve -- <ID>      show one request and decide it
// Decisions need an interactive terminal (TTY): an AI agent's non-interactive shell
// cannot approve on the user's behalf.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { config } from 'dotenv';
import { Policy } from '../core/policy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: join(root, '.env'), quiet: true });
const policy = Policy.fromEnv(root);
const id = process.argv[2];
const fa = (n: number) => n.toLocaleString('fa-IR');
const minutesLeft = (t: number) => Math.max(0, Math.round((t - Date.now()) / 60_000));

if (!id) {
  const pending = policy.approvals.list({ status: 'pending' });
  if (!pending.length) console.log('درخواست تأیید در انتظاری وجود ندارد.');
  for (const r of pending) console.log(`${r.id}  [${r.tier}]  ${r.preview.title}  — ${r.source}، ${fa(minutesLeft(r.expiresAt))} دقیقه مانده`);
  process.exit(0);
}

const r = policy.approvals.get(id);
if (!r) {
  console.error(`درخواست ${id} پیدا نشد.`);
  process.exit(1);
}
console.log(`\n${r.id} — ${r.preview.title}  [${r.tier === 'T1' ? 'کم‌خطر' : 'تغییر مهم'}]`);
r.preview.lines.forEach((l) => console.log(`  • ${l}`));
if (r.preview.cost) console.log(`  هزینه: ${r.preview.cost}`);
console.log(`  ریسک: ${r.preview.risk}\n  قطعی: ${r.preview.downtime}\n  راه برگشت: ${r.preview.undo}`);
console.log(`  وضعیت: ${r.status}`);

if (r.status !== 'pending') process.exit(0);
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('\nتأیید فقط در یک ترمینال تعاملی ممکن است (برای اینکه یک ایجنت نتواند به‌جای شما تأیید کند).');
  process.exit(2);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('\nاجرا شود؟ برای تأیید «yes» بنویسید، برای رد «no»: ')).trim().toLowerCase();
let reason: string | undefined;
if (answer !== 'yes') reason = (await rl.question('دلیل رد (اختیاری): ')).trim() || undefined;
rl.close();

const decided = policy.approvals.decide(r.id, { approved: answer === 'yes', by: 'user', channel: 'terminal', reason });
policy.audit({ tool: decided.tool, tier: decided.tier, args: decided.args, outcome: decided.status === 'approved' ? 'approved' : 'rejected', approvedBy: 'user (terminal)', approvalId: decided.id, detail: reason });
console.log(decided.status === 'approved' ? '\n✅ تأیید شد. حالا به ایجنت بگویید ادامه دهد.' : '\n🚫 رد شد.');
