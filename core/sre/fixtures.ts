// Snapshot builders for detector and RCA tests. Each scenario mirrors a
// Broken Shop fault so tests describe exactly what the demo shows.
import type { Snapshot } from './snapshot.js';
import type { Plan } from '../plan-advisor.js';

export const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
export const MIN = 60_000;
const MB = 1024 * 1024;

export const PLANS: Plan[] = [
  { id: 'small-g2', ramGB: 0.5, cpu: 0.5, hourly: 659.72, monthly: 475000 },
  { id: 'medium-g2', ramGB: 1, cpu: 1, hourly: 1145.83, monthly: 825000 },
  { id: 'standard-base-g2', ramGB: 2, cpu: 1, hourly: 2048.61, monthly: 1475000 },
];

const healthyProbe = (url = 'https://broken-shop.liara.run/') => ({
  url,
  samples: [],
  okRatio: 1,
  p50: 40,
  p95: 60,
  healthy: true,
});

function accessLogs(fromMin: number, toMin: number, status = 200, ms = 5, path = '/') {
  const out = [];
  for (let m = fromMin; m < toMin; m++) out.push({ at: NOW - (30 - m) * MIN, message: `GET ${path} ${status} ${ms}ms`, type: 'stdout' });
  return out;
}

export function healthy(): Snapshot {
  return {
    app: 'broken-shop',
    collectedAt: NOW,
    windowStart: NOW - 30 * MIN,
    appInfo: { status: 'RUNNING', scale: 1, planID: 'small-g2', planRamGB: 0.5, planCpu: 0.5, envNames: ['DATABASE_URL'], platform: 'node' },
    releases: [
      { id: 'r2', state: 'READY', createdAt: NOW - 120 * MIN, port: 3000 },
      { id: 'r1', state: 'READY', createdAt: NOW - 600 * MIN, port: 3000 },
    ],
    currentReleaseId: 'r2',
    logs: [{ at: NOW - 120 * MIN, message: 'Broken Shop listening on port 3000 faults=[none]' }, ...accessLogs(0, 30)],
    events: [],
    applets: [{ state: 'RUNNING' }],
    memoryBytes: Array.from({ length: 30 }, (_, i) => ({ t: NOW - (30 - i) * MIN, v: (80 + (i % 3)) * MB })),
    cpuCores: Array.from({ length: 30 }, (_, i) => ({ t: NOW - (30 - i) * MIN, v: 0.02 })),
    disks: [],
    probe: healthyProbe(),
    availablePlans: PLANS,
    gaps: [],
  };
}

export function missingEnv(): Snapshot {
  const s = healthy();
  s.appInfo.envNames = [];
  s.logs = [
    { at: NOW - 10 * MIN, message: 'Broken Shop listening on port 3000 faults=[none]' },
    ...Array.from({ length: 8 }, (_, i) => ({
      at: NOW - (9 - i) * MIN,
      message: '[error] GET /: Error: DATABASE_URL is not set: cannot connect to the database\n    at db (/app/server.js:39:19)\n    at loadProducts (/app/server.js:63:16)',
      type: 'stderr',
    })),
    ...accessLogs(21, 30, 500, 3),
  ];
  s.releases = [{ id: 'r1', state: 'READY', createdAt: NOW - 11 * MIN, port: 3000 }];
  s.currentReleaseId = 'r1';
  s.probe = { url: 'https://broken-shop.liara.run/', samples: [], okRatio: 0, p50: 20, p95: 30, healthy: false };
  s.codeEnv = {
    used: [{ name: 'DATABASE_URL', optional: false, locations: ['server.js:39'] }],
    documented: ['DATABASE_URL'],
    missing: [{ name: 'DATABASE_URL', optional: false, locations: ['server.js:39'], documented: true }],
  };
  return s;
}

export function memoryLeak(): Snapshot {
  const s = healthy();
  // grows from 100 MB to ~490 MB of a 512 MB plan, then the container is OOM-killed
  s.memoryBytes = Array.from({ length: 30 }, (_, i) => ({ t: NOW - (30 - i) * MIN, v: (100 + i * 13.5) * MB }));
  s.logs = [
    ...accessLogs(0, 30),
    ...Array.from({ length: 30 }, (_, i) => ({ at: NOW - (30 - i) * MIN, message: `[mem] rss=${100 + Math.round(i * 13.5)}MB cached_items=${i * 3}` })),
  ];
  s.events = [{ at: NOW - 1 * MIN, text: 'Container broken-shop was OOMKilled (exit code 137)' }];
  s.probe = { url: 'https://broken-shop.liara.run/', samples: [], okRatio: 0.6, p50: 300, p95: 2500, healthy: false };
  return s;
}

export function slowNPlusOne(): Snapshot {
  const s = healthy();
  const logs: Snapshot['logs'] = [];
  for (let r = 0; r < 6; r++) {
    const at = NOW - (20 - r * 3) * MIN;
    logs.push({ at, message: '[db] SELECT * FROM products' });
    for (let id = 1; id <= 20; id++) logs.push({ at: at + id * 150, message: `[db] SELECT * FROM prices WHERE product_id = ${id}` });
    logs.push({ at: at + 3100, message: 'GET /products 200 3376ms' });
  }
  s.logs = logs;
  s.probe = { url: 'https://broken-shop.liara.run/products', samples: [], okRatio: 1, p50: 3300, p95: 3400, healthy: false };
  return s;
}

export function badRelease(): Snapshot {
  const s = healthy();
  s.releases = [
    { id: 'r3', state: 'READY', createdAt: NOW - 8 * MIN, port: 3000 },
    { id: 'r2', state: 'READY', createdAt: NOW - 120 * MIN, port: 3000 },
  ];
  s.currentReleaseId = 'r3';
  s.logs = [
    ...accessLogs(0, 22),
    { at: NOW - 8 * MIN, message: 'Broken Shop listening on port 3000 faults=[bad_release]' },
    ...Array.from({ length: 7 }, (_, i) => ({
      at: NOW - (7 - i) * MIN,
      message: "[error] GET /: TypeError: Cannot read properties of undefined (reading 'name')\n    at /app/server.js:84:61",
      type: 'stderr',
    })),
    ...accessLogs(23, 30, 500, 4),
  ];
  s.probe = { url: 'https://broken-shop.liara.run/', samples: [], okRatio: 0, p50: 10, p95: 15, healthy: false };
  return s;
}

export function portMismatch(): Snapshot {
  const s = healthy();
  s.releases[0].port = 3000;
  s.logs = [{ at: NOW - 5 * MIN, message: 'Server listening on port 8080' }];
  s.probe = { url: 'https://broken-shop.liara.run/', samples: [], okRatio: 0, p50: 50, p95: 60, healthy: false };
  return s;
}

export function blockedRegistry(): Snapshot {
  const s = healthy();
  s.releases = [{ id: 'r9', state: 'FAILED', createdAt: NOW - 3 * MIN, port: 3000 }, ...s.releases];
  s.buildLines = [
    'npm install',
    'npm ERR! code E403',
    'npm ERR! 403 403 Forbidden - GET https://registry.npmjs.org/sharp - Forbidden',
  ];
  return s;
}

export function appOff(): Snapshot {
  const s = healthy();
  s.appInfo.scale = 0;
  s.appInfo.status = 'OFF';
  s.logs = [];
  s.probe = { url: 'https://broken-shop.liara.run/', samples: [], okRatio: 0, p50: 0, p95: 0, healthy: false };
  return s;
}
