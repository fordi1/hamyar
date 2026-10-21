// Talk to the real agent from the terminal: real model, real tools, real Liara account.
// Change tools stop at an approval prompt answered in this terminal.
// Usage: npm run chat -- "پیام شما"
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { LiaraClient } from '../core/liara-client.js';
import { Policy } from '../core/policy.js';
import { buildTools, llmFromEnv, runAgent } from '../core/agent.js';

const message = process.argv.slice(2).join(' ');
const llm = llmFromEnv();
if (!llm || !message) {
  console.error(!llm ? 'No AI provider configured in .env' : 'Usage: npm run chat -- "message"');
  process.exit(1);
}

const ctx = { client: LiaraClient.fromEnv(), policy: Policy.fromEnv(), boards: new Map() };
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log(`model: ${llm.provider} · ${llm.model}\n`);
const started = Date.now();

await runAgent({
  llm,
  tools: buildTools(ctx),
  history: [],
  userMessage: message,
  hooks: {
    onEvent(e) {
      if (e.type === 'tool' && e.status === 'start') console.log(`… ${e.name} ${JSON.stringify(e.args ?? {})}`);
      else if (e.type === 'tool') console.log(`${e.status === 'error' ? '✗' : '✓'} ${e.name} (${Math.round((Date.now() - started) / 1000)}s)`);
      else if (e.type === 'assistant') console.log(`\n${e.text}\n`);
    },
    async requestApproval(r) {
      console.log(`\n🛑 ${r.preview.title}\n${r.preview.lines.map((l) => `  • ${l}`).join('\n')}`);
      const answer = (await rl.question('approve? (y/N) ')).trim().toLowerCase();
      return { approved: answer === 'y' };
    },
  },
});
rl.close();
