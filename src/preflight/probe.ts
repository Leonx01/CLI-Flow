/**
 * Adapter probe: check reachability of adapters before workflow execution.
 *
 * Probes are lightweight pre-checks that do NOT execute the adapter func.
 * - LOCAL: always ok (just checks registration)
 * - PUBLIC: HTTP HEAD to the adapter's domain (5s timeout)
 * - COOKIE/UI/INTERCEPT: checks browser daemon health
 * - Bridge: calls bridge.health()
 */

import { getRegistry, type CliCommand, Strategy } from '@jackwener/opencli/registry';

export interface ProbeResult {
  adapter: string;
  strategy: string;
  status: 'ok' | 'timeout' | 'unreachable' | 'no-bridge' | 'no-auth' | 'not-found';
  latencyMs?: number;
  issue?: string;
  columns?: string[];
  args?: string[];
}

const PROBE_TIMEOUT = 5000;
// Public endpoints (github, HN, lobsters …) intermittently fail a single HEAD
// with an instant network error (EBADF / ECONNRESET / "fetch failed") even when
// they're healthy — a one-shot probe then falsely reports "unreachable" while
// the actual run (which has on_error: retry) sails through. Retry the cheap,
// fast failures a few times; only give the expensive timeout path one extra
// attempt so a genuinely-down domain doesn't stall preflight for 15s each.
const PROBE_NET_ATTEMPTS = 3;
const PROBE_TIMEOUT_ATTEMPTS = 2;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function probeAdapter(cmd: CliCommand): Promise<ProbeResult> {
  const name = `${cmd.site}/${cmd.name}`;
  const strategy = cmd.strategy ?? (cmd.browser ? Strategy.COOKIE : Strategy.PUBLIC);
  const base: ProbeResult = {
    adapter: name,
    strategy: String(strategy),
    status: 'ok',
    columns: cmd.columns,
    args: cmd.args.map(a => a.name),
  };

  if (strategy === Strategy.LOCAL) {
    return base;
  }

  if (strategy === Strategy.PUBLIC) {
    return probePublic(cmd, base);
  }

  if (strategy === Strategy.COOKIE || strategy === Strategy.UI || strategy === Strategy.INTERCEPT) {
    return probeBrowser(cmd, base);
  }

  return base;
}

async function probePublic(cmd: CliCommand, base: ProbeResult): Promise<ProbeResult> {
  const url = resolveProbeUrl(cmd);
  if (!url) {
    return base;
  }

  let timeoutAttemptsLeft = PROBE_TIMEOUT_ATTEMPTS;
  for (let attempt = 1; attempt <= PROBE_NET_ATTEMPTS; attempt++) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
      });
      base.latencyMs = Date.now() - start;

      // 5xx is transient server-side trouble — retry before condemning it.
      if (res.status >= 500) {
        base.status = 'unreachable';
        base.issue = `HTTP ${res.status} from ${url}`;
        if (attempt < PROBE_NET_ATTEMPTS) { await sleep(300 * attempt); continue; }
        return base;
      }
      // <500 (incl. 4xx like 403 blocks) means the host answered — reachable.
      base.status = 'ok';
      base.issue = undefined;
      return base;
    } catch (err: unknown) {
      base.latencyMs = Date.now() - start;
      if (err instanceof Error && err.name === 'AbortError') {
        base.status = 'timeout';
        base.issue = `No response from ${url} within ${PROBE_TIMEOUT}ms`;
        // Timeouts are expensive; allow only a limited number of extra tries.
        if (--timeoutAttemptsLeft > 0 && attempt < PROBE_NET_ATTEMPTS) { await sleep(300); continue; }
        return base;
      }
      base.status = 'unreachable';
      base.issue = err instanceof Error ? err.message : String(err);
      if (attempt < PROBE_NET_ATTEMPTS) { await sleep(300 * attempt); continue; }
      return base;
    } finally {
      clearTimeout(timer);
    }
  }
  return base;
}

async function probeBrowser(_cmd: CliCommand, base: ProbeResult): Promise<ProbeResult> {
  try {
      // @ts-ignore — opencli internal, dynamic import with fallback
    const { getDaemonHealth } = await import('@jackwener/opencli/browser/daemon-transport' as string);
    const health = await getDaemonHealth({ timeout: 3000 });

    if (health.state === 'ready') {
      return base;
    }

    base.status = 'no-bridge';
    const messages: Record<string, string> = {
      stopped: 'Browser daemon not running. Start with: opencli daemon start',
      'no-extension': 'Browser extension not connected. Install from Chrome Web Store.',
      'profile-required': 'Browser profile selection required. Run: opencli auth profile',
      'profile-disconnected': 'Browser profile disconnected. Reconnect the extension.',
    };
    base.issue = messages[health.state] || `Browser bridge state: ${health.state}`;
  } catch {
    base.status = 'no-bridge';
    base.issue = 'Cannot reach browser daemon';
  }
  return base;
}

function resolveProbeUrl(cmd: CliCommand): string | undefined {
  if (cmd.domain) {
    return `https://${cmd.domain}`;
  }

  if (cmd.pipeline && Array.isArray(cmd.pipeline)) {
    for (const step of cmd.pipeline) {
      const fetchStep = step as Record<string, unknown>;
      if (fetchStep.fetch && typeof fetchStep.fetch === 'object') {
        const fetchConfig = fetchStep.fetch as Record<string, unknown>;
        if (typeof fetchConfig.url === 'string') {
          try {
            const parsed = new URL(fetchConfig.url);
            return parsed.origin;
          } catch {
            // template URL, can't probe
          }
        }
      }
    }
  }

  return undefined;
}

export async function probeAdapters(
  target?: string,
  opts?: { strategy?: string },
): Promise<ProbeResult[]> {
  const registry = getRegistry();

  let commands: CliCommand[];

  if (!target) {
    commands = Array.from(registry.values());
  } else if (target.includes('/')) {
    const cmd = registry.get(target);
    if (!cmd) {
      return [{ adapter: target, strategy: 'unknown', status: 'not-found', issue: `Adapter "${target}" not found` }];
    }
    commands = [cmd];
  } else {
    commands = Array.from(registry.values()).filter(c => c.site === target);
    if (commands.length === 0) {
      return [{ adapter: `${target}/*`, strategy: 'unknown', status: 'not-found', issue: `No adapters found for site "${target}"` }];
    }
  }

  if (opts?.strategy) {
    commands = commands.filter(c => {
      const s = c.strategy ?? (c.browser ? Strategy.COOKIE : Strategy.PUBLIC);
      return String(s) === opts.strategy;
    });
  }

  const results: ProbeResult[] = [];
  const domainCache = new Map<string, ProbeResult>();

  for (const cmd of commands) {
    const strategy = cmd.strategy ?? (cmd.browser ? Strategy.COOKIE : Strategy.PUBLIC);

    if (strategy === Strategy.PUBLIC && cmd.domain) {
      const cached = domainCache.get(cmd.domain);
      if (cached) {
        results.push({
          ...cached,
          adapter: `${cmd.site}/${cmd.name}`,
          columns: cmd.columns,
          args: cmd.args.map(a => a.name),
        });
        continue;
      }
    }

    const result = await probeAdapter(cmd);
    results.push(result);

    if (strategy === Strategy.PUBLIC && cmd.domain) {
      domainCache.set(cmd.domain, result);
    }
  }

  return results;
}
