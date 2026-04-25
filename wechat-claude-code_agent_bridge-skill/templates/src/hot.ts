import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BRIDGE_ENTRY = path.join(ROOT, 'src', 'bridge.ts');
const WATCHED_TOP_LEVEL = new Set([
  'bridge.config.json',
  'bridge.config.example.json',
  'credentials.json',
  'package.json',
  'tsconfig.json',
]);

let child: ChildProcess | null = null;
let shuttingDown = false;
let restarting = false;
let restartPending = false;
let lastReason = 'initial start';
let restartTimer: NodeJS.Timeout | null = null;
const watchers: fs.FSWatcher[] = [];

function startBridge() {
  console.log(`[hot] 启动 bridge: ${BRIDGE_ENTRY}`);
  const proc = spawn(process.execPath, ['--import', 'tsx', BRIDGE_ENTRY], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  child = proc;
  proc.once('exit', (code, signal) => {
    if (child === proc) child = null;
    console.log(`[hot] bridge 已退出 code=${code ?? '-'} signal=${signal ?? '-'}`);

    if (shuttingDown || restarting) return;
    scheduleRestart(`bridge exited (${signal ?? code ?? 'unknown'})`);
  });
}

async function stopBridge(forceAfterMs = 3000): Promise<void> {
  const proc = child;
  if (!proc || proc.exitCode !== null) {
    child = null;
    return;
  }

  child = null;

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    proc.once('exit', finish);

    try {
      proc.kill('SIGTERM');
    } catch {
      finish();
      return;
    }

    setTimeout(() => {
      if (proc.exitCode === null) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }, forceAfterMs);

    setTimeout(finish, forceAfterMs + 500);
  });
}

async function restartBridge(reason: string): Promise<void> {
  if (shuttingDown) return;
  lastReason = reason;

  if (restarting) {
    restartPending = true;
    return;
  }

  restarting = true;

  do {
    restartPending = false;
    console.log(`[hot] 检测到变更，重启 bridge: ${lastReason}`);
    await stopBridge(1000);
    if (!shuttingDown) {
      startBridge();
    }
  } while (restartPending && !shuttingDown);

  restarting = false;
}

function scheduleRestart(reason: string) {
  lastReason = reason;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartBridge(lastReason);
  }, 250);
}

function setupWatchers() {
  const srcDir = path.join(ROOT, 'src');

  watchers.push(fs.watch(srcDir, { recursive: true }, (_eventType, filename) => {
    const name = filename?.toString() ?? '';
    if (!name || !name.match(/\.(ts|mts|cts|js|mjs|cjs)$/)) return;
    scheduleRestart(`src/${name} changed`);
  }));

  watchers.push(fs.watch(ROOT, (_eventType, filename) => {
    const name = filename?.toString() ?? '';
    if (!WATCHED_TOP_LEVEL.has(name)) return;
    scheduleRestart(`${name} changed`);
  }));
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  console.log(`[hot] 收到 ${signal}，停止 watcher 和 bridge...`);
  await stopBridge(1000);
  process.exit(0);
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

setupWatchers();
startBridge();
