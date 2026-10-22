import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgent, buildTools, type LLM, type ChatMessage, type AgentEvent, type ApprovalRequest } from './agent.js';
import { Policy } from './policy.js';
import type { OpsContext } from './ops.js';

// Scripted LLM: returns the queued replies in order and records what it was sent.
function scriptedLLM(replies: Awaited<ReturnType<LLM['chat']>>[]) {
  const seen: ChatMessage[][] = [];
  const llm: LLM = {
    async chat(messages) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      return replies.shift() ?? { content: 'done' };
    },
  };
  return { llm, seen };
}

const call = (name: string, args: object, id = 'c1') => ({ tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });

function context(clientOverrides: Record<string, any> = {}) {
  const calls: string[] = [];
  const client = {
    getApp: async () => ({ _id: 'id1', project_id: 'shop', planID: 'small-g2', envs: [{ key: 'A', value: '1' }] }),
    restart: async (n: string) => { calls.push(`restart:${n}`); return {}; },
    updateEnvs: async (n: string, vars: any[]) => { calls.push(`envs:${n}:${vars.map((v) => `${v.key}`).join(',')}`); return {}; },
    balance: async () => 1000,
    listApps: async () => [{ project_id: 'shop', type: 'node', planID: 'small-g2', status: 'RUNNING', scale: 1 }],
    ...clientOverrides,
  } as any;
  const policy = new Policy({ mode: 'review', auditPath: join(mkdtempSync(join(tmpdir(), 'hamyar-agent-')), 'audit.jsonl') });
  const ctx: OpsContext = { client, policy, boards: new Map() };
  return { ctx, calls };
}

function hooks(decision: (r: ApprovalRequest) => { approved: boolean; reason?: string; values?: Record<string, string> }) {
  const events: AgentEvent[] = [];
  const requests: ApprovalRequest[] = [];
  return {
    events,
    requests,
    hooks: {
      onEvent: (e: AgentEvent) => events.push(e),
      requestApproval: async (r: ApprovalRequest) => { requests.push(r); return decision(r); },
    },
  };
}

describe('runAgent', () => {
  it('runs a read-only tool and feeds its output back to the model', async () => {
    const { ctx } = context();
    const { llm, seen } = scriptedLLM([call('liara_overview', {}), { content: 'یک برنامه دارید.' }]);
    const h = hooks(() => ({ approved: true }));
    const history = await runAgent({ llm, tools: buildTools(ctx), history: [], userMessage: 'چه خبر؟', hooks: h.hooks });
    expect(h.requests).toEqual([]);
    expect(seen[1].at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(seen[1].at(-1)?.content).toContain('shop');
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'یک برنامه دارید.' });
    expect(h.events.map((e) => e.type)).toEqual(['tool', 'tool', 'assistant']);
  });

  it('pauses a change for human approval and executes only after yes', async () => {
    const { ctx, calls } = context();
    const { llm } = scriptedLLM([call('restart_app', { app: 'shop' }), { content: 'ری‌استارت شد.' }]);
    const h = hooks(() => ({ approved: true }));
    await runAgent({ llm, tools: buildTools(ctx), history: [], userMessage: 'ری‌استارتش کن', hooks: h.hooks });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ tool: 'restart_app', tier: 'T1' });
    expect(calls).toEqual(['restart:shop']);
    expect(ctx.policy.recent().map((e) => [e.outcome, e.approvedBy])).toEqual([['previewed', undefined], ['executed', 'user (dashboard)']]);
  });

  it('does nothing on reject and tells the model why', async () => {
    const { ctx, calls } = context();
    const { llm, seen } = scriptedLLM([call('restart_app', { app: 'shop' }), { content: 'باشه.' }]);
    const h = hooks(() => ({ approved: false, reason: 'سایت در حال فروش است' }));
    await runAgent({ llm, tools: buildTools(ctx), history: [], userMessage: 'ری‌استارت', hooks: h.hooks });
    expect(calls).toEqual([]);
    expect(seen[1].at(-1)?.content).toContain('سایت در حال فروش است');
    expect(ctx.policy.recent().at(-1)?.outcome).toBe('rejected');
  });

  it('collects secret env values from the human, never from or to the model', async () => {
    const { ctx, calls } = context();
    const { llm, seen } = scriptedLLM([call('set_env', { app: 'shop', keys: ['DATABASE_URL'] }), { content: 'تنظیم شد.' }]);
    const h = hooks(() => ({ approved: true, values: { DATABASE_URL: 'postgres://u:topsecret@h/db' } }));
    await runAgent({ llm, tools: buildTools(ctx), history: [], userMessage: 'متغیر را تنظیم کن', hooks: h.hooks });
    expect(h.requests[0].needsValues).toEqual(['DATABASE_URL']);
    expect(calls).toEqual(['envs:shop:A,DATABASE_URL']);
    expect(JSON.stringify(seen)).not.toContain('topsecret');
    expect(JSON.stringify(h.events)).not.toContain('topsecret');
  });

  it('masks secrets that appear in tool output before the model sees them', async () => {
    const { ctx } = context({ listApps: async () => [{ project_id: 'postgres://admin:hunter2@db/x', type: 'node', planID: 'p', status: 'RUNNING', scale: 1 }] });
    const { llm, seen } = scriptedLLM([call('liara_overview', {}), { content: 'ok' }]);
    await runAgent({ llm, tools: buildTools(ctx), history: [], userMessage: 'x', hooks: hooks(() => ({ approved: true })).hooks });
    expect(JSON.stringify(seen[1])).not.toContain('hunter2');
  });

  it('sends structured tool data to the UI but only text to the model', async () => {
    const { ctx } = context();
    const tool = { name: 'probe_x', description: 'x', parameters: {}, kind: 'read' as const, run: async () => ({ text: 'summary for model', data: { kind: 'board', secretish: 'ui-only' } }) };
    const { llm, seen } = scriptedLLM([call('probe_x', {}), { content: 'ok' }]);
    const h = hooks(() => ({ approved: true }));
    await runAgent({ llm, tools: [...buildTools(ctx), tool], history: [], userMessage: 'x', hooks: h.hooks });
    expect(seen[1].at(-1)?.content).toBe('summary for model');
    expect(JSON.stringify(seen)).not.toContain('ui-only');
    expect(h.events.find((e) => e.type === 'tool' && e.status === 'done')).toMatchObject({ data: { kind: 'board' } });
  });

  it('masks the app env values (known secrets) in tool output sent to the model', async () => {
    const { ctx } = context({ listApps: async () => [{ project_id: 'shop', type: 'node', planID: 'p', status: 'connected to db with pa55-word-xyz', scale: 1 }] });
    const { llm, seen } = scriptedLLM([call('liara_overview', {}), { content: 'ok' }]);
    await runAgent({ llm, tools: buildTools(ctx), history: [], userMessage: 'x', hooks: hooks(() => ({ approved: true })).hooks, knownSecrets: ['pa55-word-xyz'] });
    expect(JSON.stringify(seen[1])).not.toContain('pa55-word-xyz');
  });

  it('stops after the step limit', async () => {
    const { ctx } = context();
    const { llm } = scriptedLLM(Array.from({ length: 20 }, (_, i) => call('liara_overview', {}, `c${i}`)));
    const history = await runAgent({ llm, tools: buildTools(ctx), history: [], userMessage: 'x', hooks: hooks(() => ({ approved: true })).hooks, maxSteps: 3 });
    expect(history.at(-1)?.content).toMatch(/مرحله/);
  });

  it('reports unknown tools to the model instead of crashing', async () => {
    const { ctx } = context();
    const { llm, seen } = scriptedLLM([call('delete_app', { app: 'shop' }), { content: 'نمی‌شود.' }]);
    await runAgent({ llm, tools: buildTools(ctx), history: [], userMessage: 'حذفش کن', hooks: hooks(() => ({ approved: true })).hooks });
    expect(seen[1].at(-1)?.content).toMatch(/وجود ندارد|حذف/);
  });
});
