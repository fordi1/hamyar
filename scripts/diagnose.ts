// Investigate a Liara app (read-only) and print the hypothesis board.
// Usage: npm run diagnose -- <app> [--dir <local project folder>] [--path /products]
import 'dotenv/config';
import { LiaraClient } from '../core/liara-client.js';
import { diagnose, renderBoard } from '../core/sre/diagnose.js';

const args = process.argv.slice(2);
const app = args[0];
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!app) {
  console.error('Usage: npm run diagnose -- <app> [--dir <folder>] [--path /products]');
  process.exit(1);
}

const board = await diagnose(LiaraClient.fromEnv(), app, { projectDir: flag('--dir'), probePath: flag('--path') });
console.log(renderBoard(board));
