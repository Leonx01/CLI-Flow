/**
 * Service probe: extract and check external service dependencies for a workflow.
 *
 * Only surfaces non-LOCAL adapters — LOCAL adapters (local/save-json, etc.)
 * need no network or auth and are excluded from the output.
 */

import { getRegistry, Strategy, type CliCommand } from '@jackwener/opencli/registry';
import { probeAdapter } from './probe.js';
import type { WorkflowDefinition } from '../schema/types.js';

export interface ServiceStatus {
  site: string;
  strategy: string;
  adapters: string[];
  authRequired: boolean;
  reachable: 'ok' | 'timeout' | 'unreachable' | 'no-bridge' | 'not-found' | 'unknown';
  reachableDetail?: string;
  latencyMs?: number;
  auth: 'not-needed' | 'api-key-set' | 'api-key-missing' | 'logged-in' | 'needs-login' | 'unknown';
}

export interface ServiceProbeResult {
  workflow: string;
  services: ServiceStatus[];
}

const ENV_VAR_MAP: Record<string, string[]> = {
  dashscope: ['DASHSCOPE_API_KEY'],
  llm: ['LLM_ENDPOINT', 'OPENCLI_AI_ENDPOINT'],
};

function checkEnvVars(site: string): boolean {
  const knownVars = ENV_VAR_MAP[site];
  if (knownVars) {
    return knownVars.some(v => !!process.env[v]);
  }
  const generic = `${site.toUpperCase()}_API_KEY`;
  return !!process.env[generic];
}

interface SiteInfo {
  adapters: Set<string>;
  authRequired: boolean;
}

export function extractExternalServices(definition: WorkflowDefinition): Map<string, SiteInfo> {
  const registry = getRegistry();
  const sites = new Map<string, SiteInfo>();

  for (const [_stepName, step] of Object.entries(definition.steps)) {
    if (!step.adapter) continue;
    if (step.type === 'workflow') continue;

    const site = step.adapter.split('/')[0];
    const cmd = registry.get(step.adapter);
    const strategy = cmd
      ? (cmd.strategy ?? (cmd.browser ? Strategy.COOKIE : Strategy.PUBLIC))
      : null;

    if (strategy === Strategy.LOCAL) continue;

    let info = sites.get(site);
    if (!info) {
      info = { adapters: new Set(), authRequired: false };
      sites.set(site, info);
    }
    info.adapters.add(step.adapter);
    if (step.auth) info.authRequired = true;
  }

  return sites;
}

export async function probeServices(definition: WorkflowDefinition): Promise<ServiceProbeResult> {
  const registry = getRegistry();
  const siteMap = extractExternalServices(definition);
  const services: ServiceStatus[] = [];

  for (const [site, info] of siteMap) {
    const representativeAdapter = info.adapters.values().next().value!;
    const cmd = registry.get(representativeAdapter);

    if (!cmd) {
      services.push({
        site,
        strategy: 'unknown',
        adapters: Array.from(info.adapters),
        authRequired: info.authRequired,
        reachable: 'not-found',
        reachableDetail: `Adapter "${representativeAdapter}" not found in registry`,
        auth: 'unknown',
      });
      continue;
    }

    const strategy = cmd.strategy ?? (cmd.browser ? Strategy.COOKIE : Strategy.PUBLIC);
    const strategyStr = String(strategy).toLowerCase();
    const probe = await probeAdapter(cmd);

    const status: ServiceStatus = {
      site,
      strategy: strategyStr,
      adapters: Array.from(info.adapters),
      authRequired: info.authRequired,
      reachable: probe.status === 'ok' ? 'ok'
        : probe.status === 'no-auth' ? 'ok'
        : probe.status as ServiceStatus['reachable'],
      reachableDetail: probe.issue,
      latencyMs: probe.latencyMs,
      auth: 'not-needed',
    };

    if (strategy === Strategy.COOKIE || strategy === Strategy.UI || strategy === Strategy.INTERCEPT) {
      status.auth = probe.status === 'ok' ? 'logged-in' : 'needs-login';
    } else if (info.authRequired || ENV_VAR_MAP[site]) {
      status.auth = checkEnvVars(site) ? 'api-key-set' : 'api-key-missing';
    }

    services.push(status);
  }

  return {
    workflow: definition.name,
    services,
  };
}
