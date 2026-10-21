// Collapses raw log lines into templates ("SELECT ... WHERE id = <n>") with counts,
// so detectors and the LLM see patterns instead of thousands of lines.
export interface LogLine {
  at: number;
  message: string;
  type?: string;
}

export interface LogCluster {
  template: string;
  count: number;
  firstAt: number;
  lastAt: number;
  samples: string[];
  isError: boolean;
}

const ERROR_RE = /\b(error|exception|fatal|panic|traceback|unhandled|failed|refused|killed|out of memory)\b|\[error\]|ERR!/i;

export function isErrorLine(message: string, type?: string): boolean {
  return type === 'stderr' || ERROR_RE.test(message);
}

export function templateOf(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{24}\b/gi, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<time>')
    .replace(/(['"])(?:(?!\1).){1,80}\1/g, '<str>')
    .replace(/\d+(\.\d+)?/g, '<n>');
}

export function clusterLogs(logs: LogLine[], maxSamples = 2): LogCluster[] {
  const byTemplate = new Map<string, LogCluster>();
  for (const line of logs) {
    const template = templateOf(line.message);
    let c = byTemplate.get(template);
    if (!c) {
      c = { template, count: 0, firstAt: line.at, lastAt: line.at, samples: [], isError: isErrorLine(line.message, line.type) };
      byTemplate.set(template, c);
    }
    c.count++;
    c.firstAt = Math.min(c.firstAt, line.at);
    c.lastAt = Math.max(c.lastAt, line.at);
    if (c.samples.length < maxSamples) c.samples.push(line.message);
  }
  return [...byTemplate.values()].sort((a, b) => b.count - a.count);
}
