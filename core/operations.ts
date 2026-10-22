// Persisted operations: every executed change and its state transitions are written to
// disk, so the dashboard can show them again after a refresh and a deploy that was in
// flight during a restart can be picked up again by its release id.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LiaraClient } from './liara-client.js';
import { verifyDeployment, waitForRelease, type DeployEvent, type VerifyDeps } from './deployer.js';

export type OperationState = DeployEvent['phase'] | 'RUNNING' | 'DONE' | 'INTERRUPTED';

export interface Operation {
  id: string;
  tool: string;
  app?: string;
  approvalId?: string;
  releaseID?: string;
  state: OperationState;
  finished: boolean;
  startedAt: number;
  updatedAt: number;
  events: { at: number; phase: string; message?: string }[];
  summary?: string;
}

const FINAL = new Set(['VERIFIED_HEALTHY', 'HEALTH_FAILED', 'FAILED', 'CANCELED', 'DONE', 'INTERRUPTED']);

export class OperationStore {
  private path: string;

  constructor(opts: { path: string }) {
    this.path = opts.path;
  }

  private read(): Operation[] {
    if (!existsSync(this.path)) return [];
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return [];
    }
  }

  private write(ops: Operation[]) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    // keep the last 100 operations
    writeFileSync(tmp, JSON.stringify(ops.slice(-100), null, 1));
    renameSync(tmp, this.path);
  }

  private update(id: string, fn: (op: Operation) => void): Operation | undefined {
    const ops = this.read();
    const op = ops.find((o) => o.id === id);
    if (!op) return undefined;
    fn(op);
    op.updatedAt = Date.now();
    this.write(ops);
    return op;
  }

  start(input: { tool: string; app?: string; approvalId?: string }): Operation {
    const ops = this.read();
    const op: Operation = {
      id: randomBytes(5).toString('hex'),
      ...input,
      state: 'RUNNING',
      finished: false,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
    };
    ops.push(op);
    this.write(ops);
    return op;
  }

  event(id: string, e: DeployEvent) {
    this.update(id, (op) => {
      if (e.line) return; // build output lines are too noisy to persist
      op.state = e.phase;
      op.events.push({ at: Date.now(), phase: e.phase, message: e.message });
      if (op.events.length > 50) op.events.shift();
      // the deployer reports the new release id with the BUILDING transition
      if (e.phase === 'BUILDING' && e.message && /^[\w-]{3,}$/.test(e.message) && !op.releaseID) op.releaseID = e.message;
      if (FINAL.has(e.phase)) op.finished = true;
    });
  }

  finish(id: string, state: OperationState, summary?: string) {
    this.update(id, (op) => {
      if (!op.finished || state !== 'DONE') op.state = state;
      op.finished = true;
      if (summary) op.summary = summary.slice(0, 2000);
    });
  }

  get(id: string): Operation | undefined {
    return this.read().find((o) => o.id === id);
  }

  active(): Operation[] {
    return this.read().filter((o) => !o.finished);
  }

  recent(limit = 20): Operation[] {
    return this.read().slice(-limit).reverse();
  }
}

// On startup: anything still marked active was cut off by a restart. Deploys that already
// have a release id are followed to the end on Liara and verified; the rest cannot be
// resumed safely (an upload or an API call may or may not have happened) and are reported.
export async function resumeOperations(store: OperationStore, client: Pick<LiaraClient, 'buildLogs' | 'releases'>, deps?: VerifyDeps) {
  for (const op of store.active()) {
    if (op.releaseID && op.app && ['deploy', 'launch_app', 'rollback'].includes(op.tool)) {
      try {
        const release = await waitForRelease(client, op.releaseID, (e) => store.event(op.id, e), { timeoutMs: 15 * 60_000 });
        if (release.state !== 'READY') {
          store.finish(op.id, release.state === 'UNHEALTHY' ? 'HEALTH_FAILED' : release.state === 'CANCELED' ? 'CANCELED' : 'FAILED', 'بعد از ری‌استارت همیار ادامه داده شد: ساخت نسخه موفق نبود.');
          continue;
        }
        store.event(op.id, { phase: 'VERIFYING' });
        const { healthy, verification } = await verifyDeployment(client, op.app, op.releaseID, '/', deps);
        store.finish(op.id, healthy ? 'VERIFIED_HEALTHY' : 'HEALTH_FAILED', `بعد از ری‌استارت همیار ادامه داده شد. ${verification.reason ?? 'سلامت تأیید شد.'}`);
      } catch (err: any) {
        store.finish(op.id, 'INTERRUPTED', `پیگیری بعد از ری‌استارت ناموفق بود: ${err?.explanation ?? err?.message ?? err}`);
      }
    } else {
      store.finish(op.id, 'INTERRUPTED', 'این عملیات با ری‌استارت همیار قطع شد و ادامه‌ی خودکارش امن نیست؛ وضعیت را بررسی کنید و در صورت نیاز دوباره درخواست دهید.');
    }
  }
}
