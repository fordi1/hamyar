// End-to-end check of the MCP server through a real MCP client over stdio.
// Read-only calls plus approval-flow checks on an app name that does not exist,
// so nothing in the Liara account changes.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const GHOST = 'hamyar-test-nonexistent';

async function connect(withElicitation: boolean, answer?: { approve: boolean; reason?: string }) {
  const client = new Client({ name: 'hamyar-smoke', version: '1.0.0' }, { capabilities: withElicitation ? { elicitation: {} } : {} });
  if (withElicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      console.log(`   [elicitation shown to human]\n${String(req.params.message).split('\n').map((l) => '     ' + l).join('\n')}`);
      return { action: 'accept', content: answer ?? { approve: false } };
    });
  }
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', join(root, 'mcp', 'server.ts')], cwd: root, stderr: 'inherit' }));
  return client;
}

const show = (label: string, r: any) => console.log(`\n=== ${label}${r.isError ? ' (isError)' : ''}\n${r.content[0].text}`);

const c = await connect(false);
const { tools } = await c.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? '' : '*'}`).join(', ')}`);

show('liara_overview', await c.callTool({ name: 'liara_overview', arguments: {} }));
show('analyze_project', await c.callTool({ name: 'analyze_project', arguments: { dir: join(root, 'demo-app'), app: 'broken-shop' } }));

const preview = await c.callTool({ name: 'restart_app', arguments: { app: GHOST } });
show('restart_app (no token → preview)', preview);
const token = (preview.content as any)[0].text.match(/confirmToken="([0-9a-f]+)"/)?.[1];

show('restart_app (token, different args → blocked)', await c.callTool({ name: 'restart_app', arguments: { app: 'other-app', confirmToken: token } }));
show('restart_app (token, same args → executes, Liara says 404)', await c.callTool({ name: 'restart_app', arguments: { app: GHOST, confirmToken: token } }));
show('restart_app (token reused → blocked)', await c.callTool({ name: 'restart_app', arguments: { app: GHOST, confirmToken: token } }));
await c.close();

const no = await connect(true, { approve: false, reason: 'الان وقت مناسبی نیست' });
show('turn_on_app with elicitation, human says no', await no.callTool({ name: 'turn_on_app', arguments: { app: GHOST } }));
await no.close();

const yes = await connect(true, { approve: true });
show('turn_on_app with elicitation, human says yes (Liara 404)', await yes.callTool({ name: 'turn_on_app', arguments: { app: GHOST } }));
show('audit_log', await yes.callTool({ name: 'audit_log', arguments: { limit: 4 } }));
await yes.close();
