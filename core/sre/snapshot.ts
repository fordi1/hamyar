// The single data structure every detector reads. Built by collect.ts from the
// Liara API (or from fixtures in tests), so detectors stay pure functions.
import type { LogLine } from './cluster.js';
import type { ProbeSummary } from '../deployer.js';
import type { EnvScan } from '../env-scan.js';
import type { Plan } from '../plan-advisor.js';

export interface Point {
  t: number; // ms since epoch
  v: number;
}

export interface ReleaseInfo {
  id: string;
  state: string;
  createdAt: number;
  port?: number;
  failReason?: string;
}

export interface Snapshot {
  app: string;
  collectedAt: number;
  windowStart: number;
  appInfo: {
    status?: string;
    scale?: number;
    planID?: string;
    planRamGB?: number;
    planCpu?: number;
    envNames: string[];
    platform?: string;
  };
  releases: ReleaseInfo[];
  currentReleaseId?: string;
  logs: LogLine[];
  events: { at?: number; text: string }[];
  applets: { state?: string; reason?: string; at?: number }[];
  memoryBytes: Point[];
  cpuCores: Point[];
  disks: { name: string; usedRatio: number }[];
  probe?: ProbeSummary & { url: string };
  // lines from the last failed build, if any
  buildLines?: string[];
  // env vars the local code reads (only when a project folder was given)
  codeEnv?: EnvScan;
  // purchasable plans, so resource fixes can name a concrete bigger plan
  availablePlans?: Plan[];
  // what could not be collected, shown to the user as a limitation
  gaps: string[];
}
