// Prints the launch plan for a folder. Read-only.
// Usage: npm run analyze -- <folder> [app-name]
import 'dotenv/config';
import { resolve, basename } from 'node:path';
import { LiaraClient } from '../core/liara-client.js';
import { analyzeProject, renderLaunchPlan } from '../core/analyze.js';

const dir = resolve(process.argv[2] ?? '.');
const app = process.argv[3] ?? basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, '-');

console.log('\n' + renderLaunchPlan(await analyzeProject(LiaraClient.fromEnv(), dir, app)) + '\n');
