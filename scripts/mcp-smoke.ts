// End-to-end check of the MCP server through a real MCP client over stdio.
// Read-only calls plus approval-flow checks on an app name that does not exist,
// so nothing in the Liara account changes. Uses a throwaway state folder.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalStore } from '../core/approvals.js';

const root = join(import.meta.dirname, '..');
const GHOST = 'hamyar-test-nonexistent';
const state = mkdtempSync(join(tmpdir(), 'hamyar-mcp-smoke-'));
const env = { ...process.env, HAMYAR_STATE_DIR: state, HAMYAR_AUDIT_PATH: join(state, 'audit.jsonl') } as Record<string, string>;
// Plays the trusted human channel (dashboard or terminal) on the shared store.
const human = new ApprovalStore({ path: join(state, 'approvals.json') });

async function connect(withElicitation: boolean, answer?: { approve: boolean; reason?: string }) {
  const client = new Client({ name: 'hamyar-smoke', version: '1.0.0' }, { capabilities: withElicitation ? { elicitation: {} } : {} });
  if (withElicitation) {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: answer ?? { approve: false } }));
  }
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', join(root, 'mcp', 'server.ts')], cwd: root, env, stderr: 'inherit' }));
  return client;
}

const out = (r: any) => (r.content[0].text as string);
const show = (label: string, r: any) => console.log(`\n=== ${label}${r.isError ? ' (isError)' : ''}\n${out(r).split('\n').slice(-6).join('\n')}`);

const c = await connect(false);
const { tools } = await c.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? '' : '*'}`).join(', ')}`);
show('liara_overview', await c.callTool({ name: 'liara_overview', arguments: {} }));

const filed = await c.callTool({ name: 'restart_app', arguments: { app: GHOST } });
show('restart_app → approval request filed', filed);
const id = out(filed).match(/approvalId="([A-Z0-9]{6})"/)?.[1] ?? '';

show('model calls back with the id, nobody approved → not executed', await c.callTool({ name: 'restart_app', arguments: { app: GHOST, approvalId: id } }));
human.decide(id, { approved: true, by: 'user', channel: 'terminal' });
show('approved with different args → blocked', await c.callTool({ name: 'restart_app', arguments: { app: 'other-app', approvalId: id } }));
show('approved, same args → executes (Liara: app not found)', await c.callTool({ name: 'restart_app', arguments: { app: GHOST, approvalId: id } }));
show('same id again → blocked (single use)', await c.callTool({ name: 'restart_app', arguments: { app: GHOST, approvalId: id } }));
await c.close();

const no = await connect(true, { approve: false, reason: 'الان وقت مناسبی نیست' });
show('elicitation: human says no', await no.callTool({ name: 'turn_on_app', arguments: { app: GHOST } }));
await no.close();
const yes = await connect(true, { approve: true });
show('elicitation: human says yes (Liara 404)', await yes.callTool({ name: 'turn_on_app', arguments: { app: GHOST } }));
show('audit_log', await yes.callTool({ name: 'audit_log', arguments: { limit: 8 } }));
await yes.close();
