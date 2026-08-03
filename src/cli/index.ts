#!/usr/bin/env node
/**
 * cliflow — CLI Flow Engine
 * DAG workflow orchestrator powered by OpenCLI adapters.
 */

import { Command } from 'commander';
import { ANSI } from './ansi.js';
import { computeCoverage, evaluateStrict } from './strict.js';
import * as path from 'node:path';
import { createRequire } from 'node:module';

async function bootstrap() {
  const require = createRequire(import.meta.url);
  const opencliRoot = path.dirname(require.resolve('@jackwener/opencli/package.json'));
  const clisDir = path.join(opencliRoot, 'clis');
  const { discoverClis, USER_CLIS_DIR } = await import('@jackwener/opencli/discovery' as string);
  // Packaged adapters first, then user-local overrides/additions (~/.opencli/clis)
  await discoverClis(clisDir, USER_CLIS_DIR);

  // Bridge discovery: MCP/API/CLI bridges configured in ~/.opencli/bridges/
  // Each bridge's tools auto-register as adapters (e.g. mcp-ddg/search).
  try {
    const { discoverBridges } = await import('@jackwener/opencli/bridge/discovery' as string);
    await Promise.race([
      discoverBridges(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
  } catch {
    // Bridge discovery is optional — if the module or config is absent, or times out, continue.
  }
}

const program = new Command('cliflow')
  .version('0.1.0')
  .description('CLI Flow Engine — DAG workflow orchestrator');

// ── run ───────────────────────────────────────────────────────────────────────

program
  .command('run')
  .argument('<file>', 'Workflow YAML file path')
  .option('--resume <runId>', 'Resume from checkpoint')
  .option('--dry-run', 'Show execution plan without running', false)
  .option('-v, --verbose', 'Debug output', false)
  .option('-f, --format <fmt>', 'Output format: table, json, yaml', 'table')
  .option('--input <key=value...>', 'Workflow input parameters (key=value pairs)')
  .option('--arg <key=value...>', 'Alias for --input')
  .option('--no-trace', 'Disable execution trace recording')
  .option('--ui <mode>', 'UI mode: tui (terminal), web (browser), json (machine-readable)', 'tui')
  .option('--auto-approve', 'Auto-resolve all interact prompts without user input')
  .option('--agent-mode', 'Pause on interact nodes and output decision as JSON (for agent-driven execution)')
  .option('--answer <json>', 'Answers for pending interacts when resuming, as {"<stepName>": <answer>, ...} — answer all currently-pending steps in one call')
  .option('--prefs', 'Pre-fill interact prompts with previously saved preferences')
  .option('--preflight', 'Run preflight checks before execution')
  .option('--strict', 'Exit non-zero (code 2) if any step is skipped, has foreach item failures, or a declared output is empty')
  .option('--allow-skip <steps>', 'Comma-separated step names allowed to be skipped under --strict')
  .description('Execute a workflow definition')
  .action(async (file: string, opts) => {
    await bootstrap();
    const { parseWorkflow, WorkflowParseError } = await import('../schema/parser.js');
    const { executeWorkflow, mergeCallbacks, validateWorkflowInputs } = await import('../engine/engine.js');

    let definition;
    try {
      definition = parseWorkflow(file);
    } catch (e) {
      if (e instanceof WorkflowParseError) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
      throw e;
    }

    const inputArgs: Record<string, unknown> = {};
    const rawPairs = [...(opts.input as string[] || []), ...(opts.arg as string[] || [])];
    for (const pair of rawPairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const k = pair.slice(0, eqIdx);
        const v = pair.slice(eqIdx + 1);
        try { inputArgs[k] = JSON.parse(v); } catch { inputArgs[k] = v; }
      }
    }

    try {
      validateWorkflowInputs(definition, inputArgs);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }

    const traceHelper = opts.trace && !opts.dryRun
      ? (await import('../trace/trace.js')).createTraceCallbacks()
      : null;

    if (opts.preflight && !opts.dryRun) {
      const { preflightWorkflow } = await import('../preflight/preflight.js');
      const pfResult = await preflightWorkflow(file);
      if (!pfResult.valid) {
        for (const c of pfResult.checks.filter(c => c.status === 'fail')) {
          console.error(`${ANSI.red}✗${ANSI.reset} [${c.category}${c.step ? ':' + c.step : ''}] ${c.message}`);
        }
        for (const c of pfResult.checks.filter(c => c.status === 'warn')) {
          console.error(`${ANSI.yellow}⚠${ANSI.reset} [${c.category}${c.step ? ':' + c.step : ''}] ${c.message}`);
        }
        console.error(`\nPreflight failed with ${pfResult.errors.length} error(s).`);
        process.exit(1);
      }
    }

    const uiMode = opts.ui || (process.stderr.isTTY ? 'tui' : 'json');

    let callbacks: ReturnType<typeof mergeCallbacks>;
    let cleanup: (() => void) | null = null;
    let waitForTUIExit: (() => Promise<void>) | null = null;
    let getOutputPaths: (() => string[]) | null = null;
    let hasLiveTUI = false;
    let webServer: { httpServer: { close: () => void } } | null = null;

    if (uiMode === 'web') {
      try {
        const { createWebServer } = await import('../web/server.js');
        const server = await createWebServer({ definition });
        webServer = server;
        const webCallbacks = server.adapter.getCallbacks();
        // mergeCallbacks: first onInteract wins → WebAdapter must be first
        callbacks = mergeCallbacks(webCallbacks, traceHelper?.callbacks);
        hasLiveTUI = true;
        console.error(`\n  Web UI → http://localhost:${server.port}\n`);
      } catch (err) {
        console.error('Failed to start web server:', err instanceof Error ? err.message : String(err));
        console.error(err instanceof Error ? err.stack : '');
        process.exit(1);
      }
    } else if (uiMode === 'tui') {
      const { createInkRenderer } = await import('../ui/tui/renderer.js');
      const inkRenderer = await createInkRenderer({
        name: definition.name || 'workflow',
        steps: definition.steps || {},
      }, traceHelper?.callbacks?.onTraceEvent);
      const inkCallbacks = inkRenderer.getCallbacks();
      if (opts.autoApprove) {
        const { createInteractHandler, AUTO_APPROVE_POLICY } = await import('../engine/interact.js');
        inkCallbacks.onInteract = createInteractHandler(null, AUTO_APPROVE_POLICY);
      }
      callbacks = mergeCallbacks(inkCallbacks, traceHelper?.callbacks);
      cleanup = () => inkRenderer.unmount();
      waitForTUIExit = () => inkRenderer.waitForEnd();
      getOutputPaths = () => inkRenderer.getOutputPaths();
      hasLiveTUI = true;
    } else {
      if (opts.autoApprove) {
        const { createInteractHandler, AUTO_APPROVE_POLICY } = await import('../engine/interact.js');
        callbacks = mergeCallbacks({ onInteract: createInteractHandler(null, AUTO_APPROVE_POLICY) }, traceHelper?.callbacks);
      } else if (opts.agentMode) {
        const { createInteractHandler, PAUSE_POLICY } = await import('../engine/interact.js');
        callbacks = mergeCallbacks({ onInteract: createInteractHandler(null, PAUSE_POLICY) }, traceHelper?.callbacks);
      } else {
        callbacks = mergeCallbacks(null, traceHelper?.callbacks);
      }
    }

    if (!opts.autoApprove && !opts.agentMode && callbacks.onInteract) {
      const { wrapCallbacksWithPrefs } = await import('../engine/prefs.js');
      callbacks = wrapCallbacksWithPrefs(callbacks, definition.name, { inject: !!opts.prefs });
    }

    // Parse --answer JSON if provided (map of stepName -> answer)
    let interactAnswer: Record<string, unknown> | undefined;
    if (opts.answer) {
      try {
        const parsed = JSON.parse(opts.answer);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        interactAnswer = parsed as Record<string, unknown>;
      } catch {
        console.error('Error: --answer must be a JSON object mapping stepName to answer, e.g. \'{"choose-shop": {...}}\'');
        process.exit(1);
      }
    }

    let result;
    if (uiMode === 'web') {
      // Web mode: don't auto-run. User clicks ▶ Run in the browser.
      // Just keep the server alive until Ctrl+C.
      console.error(`\nPress Ctrl+C to stop the server.\n`);
      await new Promise(() => {}); // hang until SIGINT
    } else {
      try {
        result = await executeWorkflow(definition, inputArgs, {
          debug: opts.verbose,
          resumeRunId: opts.resume,
          dryRun: opts.dryRun,
          quiet: hasLiveTUI,
          callbacks,
          interactAnswer,
        });
      } finally {
        if (waitForTUIExit) await waitForTUIExit();
        cleanup?.();
      }
    }

    // Web mode: server hung until SIGINT, nothing more to do
    if (uiMode === 'web') return;
    // Unreachable in practice (an executeWorkflow throw propagates out of the
    // try/finally above) — guard keeps the type-narrowing happy.
    if (!result) return;

    const traceFilePath = traceHelper?.finalize(result.status, result.finishedAt, {
      terminationReason: result.terminationReason,
      finalContext: result.context,
      dataFlow: result.dataFlow,
    }) ?? null;

    let memoryHint: string | null = null;
    if (!opts.dryRun) {
      const memory = await import('../engine/memory.js');
      memoryHint = memory.getMemoryHint(definition.name, result, definition, file);
      memory.updateInsights(definition.name, result);
      if (result.status === 'completed') {
        const { hashDefinition } = await import('../engine/checkpoint.js');
        memory.saveSnapshot(definition.name, file, hashDefinition(definition));
      }
    }

    // Coverage: what actually ran vs. was skipped/failed. The engine counts
    // skipped steps into completedSteps, so "18/18 completed" can hide a skipped
    // write step or a foreach that failed every item. computeCoverage() (in
    // strict.ts) gives the honest view.
    const coverage = computeCoverage(result, definition);

    if (opts.dryRun) {
      console.log(`Execution plan for ${ANSI.bold}"${definition.name}"${ANSI.reset}:`);
      const plan = (result.context as Record<string, unknown>).executionPlan;
      if (Array.isArray(plan)) {
        plan.forEach((layer, i) => {
          const steps = (layer as { parallel: string[] }).parallel;
          const parallelNote = steps.length > 1 ? ` ${ANSI.dim}(parallel×${steps.length})${ANSI.reset}` : '';
          console.log(`  Layer ${i + 1}${parallelNote}: ${steps.join(' → ')}`);
        });
      }
    } else if (opts.format === 'json' || opts.format === 'yaml') {
      const output = {
        ...result,
        traceFile: traceFilePath,
        memoryHint: memoryHint,
        coverage,
      };
      console.log(JSON.stringify(output, null, 2));
    } else if (hasLiveTUI) {
      console.log(`${ANSI.dim}Trace at: ${traceFilePath}${ANSI.reset}`);
    } else {
      console.log(`\nWorkflow "${result.workflow}" ${result.status}`);
      console.log(`  Completed: ${result.completedSteps.length}, Failed: ${result.failedSteps.length}, Skipped: ${result.skippedSteps.length}`);
      console.log(`  Duration: ${((result.finishedAt - result.startedAt) / 1000).toFixed(1)}s`);
      console.log(`  Run ID: ${result.id}`);
      if (traceFilePath) console.log(`  Trace: ${traceFilePath}`);
    }

    // Coverage line (text mode) — surfaces skipped/foreach-failed steps that the
    // "completed" count would otherwise hide (the engine counts skips as completed).
    if (!opts.dryRun && opts.format !== 'json' && opts.format !== 'yaml' && !hasLiveTUI) {
      const parts = [`${coverage.executed} executed`];
      if (coverage.skipped.length) parts.push(`${coverage.skipped.length} skipped(${coverage.skipped.join(',')})`);
      if (coverage.foreachFailed.length) parts.push(`${coverage.foreachFailed.length} with foreach failures(${coverage.foreachFailed.join(',')})`);
      if (coverage.emptyOutputs.length) parts.push(`empty outputs: ${coverage.emptyOutputs.join(',')}`);
      console.log(`  Coverage: ${parts.join(' · ')}`);
    }

    if (memoryHint && opts.format !== 'json' && opts.format !== 'yaml') {
      console.log(`${ANSI.dim}${memoryHint}${ANSI.reset}`);
    }

    // ── --strict gate ──
    // Turn the silently-swallowed failure modes into a non-zero exit so agents/CI
    // cannot declare success on a run that skipped a step, failed foreach items,
    // or produced an empty declared output. Uses code 2 to distinguish from a
    // hard workflow failure (code 1). Skipped only when the run itself paused.
    if (opts.strict && !opts.dryRun && result.status !== 'paused') {
      const violations = evaluateStrict(result, definition, String(opts.allowSkip ?? '').split(','));
      if (violations.length) {
        console.error(`\n${ANSI.red}Strict check failed (${violations.length} violation(s)):${ANSI.reset}`);
        for (const v of violations) console.error(`  ${ANSI.red}✗${ANSI.reset} ${v}`);
        process.exit(2);
      }
    }

    if (result.status === 'failed') process.exit(1);
    if (result.status === 'paused') process.exit(0);
  });

// ── validate ──────────────────────────────────────────────────────────────────

program
  .command('validate')
  .argument('<file>', 'Workflow YAML file path')
  .description('Validate a workflow definition (syntax + DAG)')
  .option('-f, --format <fmt>', 'Output format: text, json', 'text')
  .action(async (file: string, opts: { format?: string }) => {
    const { parseWorkflow } = await import('../schema/parser.js');
    const { DAGScheduler } = await import('../engine/scheduler.js');
    try {
      const def = parseWorkflow(file);
      const scheduler = new DAGScheduler(def.steps);
      const validation = scheduler.validate();
      const { validateWorkflow } = await import('../schema/validator.js');
      const warnings = validateWorkflow(def);

      if (!validation.valid) {
        if (opts.format === 'json') {
          console.log(JSON.stringify({ valid: false, workflow: def.name, steps: Object.keys(def.steps).length, cycle: validation.cycle ?? null, warnings }, null, 2));
          process.exit(1);
        }
        console.error(`${ANSI.red}✗ DAG cycle detected: ${validation.cycle?.join(' → ')}${ANSI.reset}`);
        process.exit(1);
      }

      const waves = scheduler.plan();

      if (opts.format === 'json') {
        console.log(JSON.stringify({ valid: true, workflow: def.name, steps: Object.keys(def.steps).length, layers: waves.length, executionPlan: waves, warnings, cycle: null }, null, 2));
        return;
      }

      console.log(`${ANSI.green}✓${ANSI.reset} Workflow "${def.name}" is valid ${ANSI.dim}(${Object.keys(def.steps).length} steps, ${waves.length} layers)${ANSI.reset}`);
      waves.forEach((wave, i) => {
        const parallelNote = wave.parallel.length > 1 ? ` ${ANSI.dim}(parallel×${wave.parallel.length})${ANSI.reset}` : '';
        console.log(`  Layer ${i + 1}${parallelNote}: ${wave.parallel.join(' → ')}`);
      });
      if (warnings.length > 0) {
        console.log(`\n${ANSI.yellow}Warnings:${ANSI.reset}`);
        for (const w of warnings) {
          console.log(`  ${ANSI.yellow}⚠${ANSI.reset} ${w.step}.${w.field}: ${w.message}`);
        }
      }
    } catch (err) {
      if (opts.format === 'json') {
        console.log(JSON.stringify({ valid: false, workflow: '', steps: 0, errors: [err instanceof Error ? err.message : String(err)], warnings: [], cycle: null }, null, 2));
        process.exit(1);
      }
      console.error(`${ANSI.red}✗ Validation error: ${err instanceof Error ? err.message : err}${ANSI.reset}`);
      process.exit(1);
    }
  });

// ── trace ─────────────────────────────────────────────────────────────────────

const traceCmd = program
  .command('trace')
  .argument('[runId]', 'Run ID')
  .option('--summary', 'Agent-friendly diagnostic summary')
  .option('-f, --format <fmt>', 'Output format: text, json', 'text')
  .description('Show a workflow execution trace')
  .action(async (runId: string | undefined, opts: { summary?: boolean; format?: string }) => {
    if (!runId) {
      console.error('Provide a runId, or use "cliflow trace list".');
      process.exit(1);
    }
    const { loadTrace, generateTraceSummary } = await import('../trace/trace.js');
    const trace = loadTrace(runId);
    if (!trace) { console.error(`Trace not found: ${runId}`); process.exit(1); }

    if (opts.format === 'json') {
      const output = opts.summary
        ? { runId: trace.runId, workflow: trace.workflow, status: trace.status, summary: generateTraceSummary(trace), trace }
        : trace;
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    if (opts.summary) { console.log(generateTraceSummary(trace)); return; }

    console.log(`\nTrace for "${trace.workflow}" (run: ${trace.runId}) — ${trace.status ?? 'unknown'}\n`);
    for (const step of trace.steps) {
      const color = step.status === 'completed' ? ANSI.green : step.status === 'failed' ? ANSI.red : step.status === 'skipped' ? ANSI.yellow : ANSI.dim;
      const icon = step.status === 'completed' ? '✓' : step.status === 'failed' ? '✗' : step.status === 'skipped' ? '⊘' : '…';
      const duration = step.durationMs !== undefined ? `${(step.durationMs / 1000).toFixed(2)}s` : '-';
      console.log(`  ${color}${icon}${ANSI.reset} ${step.name.padEnd(24)} ${ANSI.dim}${duration.padStart(8)}${ANSI.reset}  ${step.status}`);
      if (step.error) console.log(`      ${ANSI.red}error: ${step.error}${ANSI.reset}`);
    }
  });

traceCmd
  .command('list')
  .description('List saved execution traces')
  .action(async () => {
    const { listTraces } = await import('../trace/trace.js');
    const traces = listTraces();
    for (const t of traces) {
      console.log(`  ${t.runId}  ${t.workflow.padEnd(24)}  ${t.status ?? 'unknown'}  ${new Date(t.startedAt).toISOString()}`);
    }
  });

// ── preflight ─────────────────────────────────────────────────────────────────

program
  .command('preflight')
  .argument('<file>', 'Workflow YAML file path')
  .description('Pre-execution check: probe adapters, validate args')
  .option('-f, --format <fmt>', 'Output format: text, json', 'text')
  .action(async (file: string, opts: { format?: string }) => {
    await bootstrap();
    const { preflightWorkflow } = await import('../preflight/preflight.js');
    const result = await preflightWorkflow(file);

    if (opts.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
      if (!result.valid) process.exit(1);
      return;
    }

    console.log(`\nPreflight check for "${result.workflow}" (${result.steps} steps)\n`);
    for (const check of result.checks) {
      const color = check.status === 'pass' ? ANSI.green : check.status === 'warn' ? ANSI.yellow : ANSI.red;
      const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
      console.log(`${color}${icon}${ANSI.reset} ${(check.step || check.category).padEnd(28)} ${check.message}`);
    }
    const resultColor = result.valid ? ANSI.green : ANSI.red;
    console.log(`\n${resultColor}${result.errors.length} errors, ${result.warnings.length} warnings${result.valid ? ' — ready' : ' — fix before running'}${ANSI.reset}`);
    if (!result.valid) process.exit(1);
  });

// ── probe ────────────────────────────────────────────────────────────────────

program
  .command('probe')
  .argument('<file>', 'Workflow YAML file path')
  .description('Probe external service dependencies for a workflow')
  .action(async (file: string) => {
    await bootstrap();
    const { parseWorkflow } = await import('../schema/parser.js');
    const { probeServices } = await import('../preflight/service-probe.js');

    const definition = parseWorkflow(file);
    const result = await probeServices(definition);

    if (result.services.length === 0) {
      console.log(`\nNo external dependencies for "${result.workflow}".`);
      return;
    }

    const maxSite = Math.max(6, ...result.services.map(s => s.site.length));
    const maxStrat = Math.max(10, ...result.services.map(s => s.strategy.length));

    console.log(`\nExternal dependencies for "${result.workflow}":\n`);
    console.log(`  ${'Site'.padEnd(maxSite)}  ${'Strategy'.padEnd(maxStrat)}  ${'Reachable'.padEnd(16)}  Auth`);
    console.log(`  ${'─'.repeat(maxSite)}  ${'─'.repeat(maxStrat)}  ${'─'.repeat(16)}  ${'─'.repeat(20)}`);

    let unreachableCount = 0;
    for (const s of result.services) {
      const reachIcon = s.reachable === 'ok'
        ? `${ANSI.green}✓${ANSI.reset}`
        : `${ANSI.red}✗${ANSI.reset}`;
      const reachText = s.reachable === 'ok'
        ? `ok${s.latencyMs ? ` (${(s.latencyMs / 1000).toFixed(1)}s)` : ''}`
        : s.reachable;
      if (s.reachable !== 'ok') unreachableCount++;

      const authIcon = s.auth === 'api-key-set' || s.auth === 'logged-in' || s.auth === 'not-needed'
        ? `${ANSI.green}✓${ANSI.reset}`
        : s.auth === 'api-key-missing' || s.auth === 'needs-login'
          ? `${ANSI.yellow}⚠${ANSI.reset}`
          : `${ANSI.dim}?${ANSI.reset}`;
      const authLabels: Record<string, string> = {
        'not-needed': '—',
        'api-key-set': 'API key set',
        'api-key-missing': 'API key missing',
        'logged-in': 'Browser session',
        'needs-login': 'Needs login',
        'unknown': 'Unknown',
      };
      const authText = authLabels[s.auth] ?? s.auth;

      console.log(
        `  ${s.site.padEnd(maxSite)}  ${s.strategy.padEnd(maxStrat)}  ${reachIcon} ${reachText.padEnd(14)}  ${authIcon} ${authText}`,
      );
    }

    console.log(`\n  ${result.services.length} external service(s), ${unreachableCount} unreachable`);
  });

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List saved workflow checkpoints')
  .action(async () => {
    const { listCheckpoints } = await import('../engine/checkpoint.js');
    const checkpoints = listCheckpoints();
    for (const cp of checkpoints) {
      console.log(`  ${cp.runId}  ${cp.workflowName.padEnd(24)}  ${cp.completedSteps.length} steps  ${new Date(cp.updatedAt).toISOString()}`);
    }
  });

// ── prefs ────────────────────────────────────────────────────────────────────

program
  .command('prefs')
  .argument('[workflow]', 'Workflow name (omit to list all)')
  .option('--clear', 'Clear saved preferences for this workflow')
  .description('View or manage saved interaction preferences')
  .action(async (workflow: string | undefined, opts) => {
    const { loadPrefs, deletePrefs, listPrefs } = await import('../engine/prefs.js');

    if (!workflow) {
      const all = listPrefs();
      if (all.length === 0) {
        console.log('No saved preferences.');
        return;
      }
      console.log('\nSaved preferences:\n');
      for (const p of all) {
        const date = p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 10) : '—';
        console.log(`  ${p.workflow.padEnd(28)} ${p.entries} entries  ${ANSI.dim}${date}${ANSI.reset}`);
      }
      return;
    }

    if (opts.clear) {
      const deleted = deletePrefs(workflow);
      console.log(deleted
        ? `${ANSI.green}✓${ANSI.reset} Cleared preferences for "${workflow}".`
        : `No preferences found for "${workflow}".`);
      return;
    }

    const store = loadPrefs(workflow);
    const entries = Object.entries(store);
    if (entries.length === 0) {
      console.log(`No saved preferences for "${workflow}".`);
      return;
    }

    console.log(`\nPreferences for "${workflow}":\n`);
    for (const [stepName, entry] of entries) {
      const date = new Date(entry.savedAt).toISOString().slice(0, 10);
      const valueStr = JSON.stringify(entry.value);
      const display = valueStr.length > 60 ? valueStr.slice(0, 57) + '...' : valueStr;
      console.log(`  ${stepName.padEnd(24)} ${ANSI.dim}${date}${ANSI.reset}  ${display}`);
    }
  });

// ── memory ───────────────────────────────────────────────────────────────────

program
  .command('memory')
  .argument('[nameOrCmd]', 'Workflow name, "list", or "adapter"')
  .argument('[action]', 'add | insights | snapshots | diff | delete | <site> (for adapter)')
  .argument('[args...]', 'action arguments')
  .option('--file <yaml>', 'Workflow YAML file, used to attach a definitionHash to a note')
  .option('-f, --format <fmt>', 'Output format: text, json', 'text')
  .description('View or manage workflow development memory (notes, insights, snapshots)')
  .action(async (nameOrCmd: string | undefined, action: string | undefined, args: string[], opts: { file?: string; format?: string }) => {
    const memory = await import('../engine/memory.js');
    const json = opts.format === 'json';

    async function hashFromFile(file?: string): Promise<string | undefined> {
      if (!file) return undefined;
      const { parseWorkflow } = await import('../schema/parser.js');
      const { hashDefinition } = await import('../engine/checkpoint.js');
      return hashDefinition(parseWorkflow(file));
    }

    if (!nameOrCmd || nameOrCmd === 'list') {
      const all = memory.listMemories();
      if (json) { console.log(JSON.stringify(all, null, 2)); return; }
      if (all.length === 0) {
        console.log('No workflow memory found.');
        return;
      }
      console.log('\nWorkflow memory:\n');
      for (const m of all) {
        console.log(`  ${m.workflow.padEnd(24)} ${String(m.noteCount).padStart(2)} notes   ${String(m.runs).padStart(3)} runs   ${m.successRate.padStart(4)} success   ${ANSI.dim}${m.lastRun}${ANSI.reset}`);
      }
      return;
    }

    if (nameOrCmd === 'adapter') {
      const site = action;
      if (!site) {
        console.error('Provide an adapter site, e.g. `cliflow memory adapter zhihu`.');
        process.exitCode = 1;
        return;
      }
      if (args[0] === 'add') {
        const text = args[1];
        if (!text) {
          console.error('Provide note text: `cliflow memory adapter <site> add "<text>"`.');
          process.exitCode = 1;
          return;
        }
        memory.addAdapterNote(site, text);
        console.log(`${ANSI.green}✓${ANSI.reset} Added note to adapter "${site}".`);
        return;
      }
      const content = memory.loadAdapterMemory(site);
      if (json) { console.log(JSON.stringify({ site, content: content ?? null }, null, 2)); return; }
      if (!content) {
        console.log(`No memory for adapter "${site}".`);
        return;
      }
      console.log(`\nAdapter notes for "${site}":\n`);
      console.log(content.trimEnd());
      return;
    }

    const name = nameOrCmd;

    if (action === 'add') {
      const text = args[0];
      if (!text) {
        console.error(`Provide note text: \`cliflow memory ${name} add "<text>"\`.`);
        process.exitCode = 1;
        return;
      }
      const hash = await hashFromFile(opts.file);
      memory.addNote(name, text, hash);
      console.log(`${ANSI.green}✓${ANSI.reset} Added note to "${name}"${hash ? ` (hash: ${hash})` : ''}.`);
      return;
    }

    if (action === 'insights') {
      const insights = memory.loadInsights(name);
      if (json) { console.log(JSON.stringify(insights ?? { total_runs: 0 }, null, 2)); return; }
      if (!insights) {
        console.log(`No insights recorded for "${name}" yet.`);
        return;
      }
      const successRate = insights.total_runs > 0 ? Math.round((insights.successes / insights.total_runs) * 100) : 0;
      console.log(`\nInsights for "${name}":\n`);
      console.log(`  ${insights.total_runs} runs, ${insights.successes} succeeded, ${insights.failures} failed (${successRate}%)`);
      console.log(`  avg duration: ${insights.avg_duration_seconds}s`);
      console.log(`  last run: ${insights.last_run_at} (${insights.last_status})`);
      if (insights.recent_failures.length > 0) {
        console.log(`\n  Recent failures:`);
        for (const f of insights.recent_failures) {
          console.log(`    ${f.step.padEnd(20)} ${ANSI.red}${f.error}${ANSI.reset}  ${ANSI.dim}${f.at}${ANSI.reset}`);
          console.log(`      trace: ${f.trace}`);
        }
      }
      return;
    }

    if (action === 'snapshots') {
      const snaps = memory.listSnapshots(name);
      if (json) { console.log(JSON.stringify(snaps, null, 2)); return; }
      if (snaps.length === 0) {
        console.log(`No snapshots for "${name}" yet.`);
        return;
      }
      console.log(`\nSnapshots for "${name}":\n`);
      for (const s of snaps) {
        const stepsStr = s.steps.length > 0 ? s.steps.join(' → ') : '?';
        console.log(`  ${s.hash.padEnd(10)} ${s.date.padEnd(18)} ${s.steps.length} steps (${stepsStr})`);
      }
      return;
    }

    if (action === 'diff') {
      const [hash1, hash2] = args;
      if (!hash1 || !hash2) {
        console.error(`Usage: cliflow memory ${name} diff <hash1> <hash2>`);
        process.exitCode = 1;
        return;
      }
      const diff = memory.diffSnapshots(name, hash1, hash2);
      if (diff === null) {
        console.error(`Snapshot not found for hash "${hash1}" or "${hash2}".`);
        process.exitCode = 1;
        return;
      }
      console.log(diff);
      return;
    }

    if (action === 'delete') {
      const deleted = memory.deleteMemory(name);
      console.log(deleted
        ? `${ANSI.green}✓${ANSI.reset} Deleted memory for "${name}".`
        : `No memory found for "${name}".`);
      return;
    }

    if (action) {
      console.error(`Unknown memory action: "${action}"`);
      process.exitCode = 1;
      return;
    }

    // Default: full overview
    const report = memory.loadMemory(name);
    if (json) { console.log(JSON.stringify(report, null, 2)); return; }
    if (report.notes.length === 0 && !report.insights && report.snapshotCount === 0) {
      console.log(`No memory found for "${name}".`);
      console.log(`  → cliflow memory ${name} add "<note>" --file <yaml>`);
      return;
    }

    console.log(`\nMemory for "${name}":\n`);
    if (report.notes.length > 0) {
      const staleCount = report.notes.filter(n => n.stale).length;
      console.log(`Notes (${report.notes.length}${staleCount > 0 ? `, ${staleCount} stale` : ''}):`);
      for (const n of report.notes) {
        const text = n.text.length > 80 ? n.text.slice(0, 77) + '...' : n.text;
        const marker = n.stale ? `${ANSI.yellow}⚠ stale${ANSI.reset} — ` : '';
        console.log(`  [${n.date}] ${marker}${text}`);
      }
      console.log('');
    }

    if (report.insights) {
      const successRate = report.insights.total_runs > 0
        ? Math.round((report.insights.successes / report.insights.total_runs) * 100)
        : 0;
      console.log(`Stats: ${report.insights.total_runs} runs, ${successRate}% success, avg ${report.insights.avg_duration_seconds}s`);
      if (report.insights.recent_failures.length > 0) {
        const last = report.insights.recent_failures[0];
        console.log(`  last failure: ${last.step} — ${last.error} (${last.at.slice(0, 10)})`);
      }
      console.log('');
    }

    if (report.snapshotCount > 0) {
      console.log(`Snapshots: ${report.snapshotCount}\n`);
    }

    console.log(`${ANSI.dim}${report.memoryDir}${ANSI.reset}`);
  });

// ── adapters ────────────────────────────────────────────────────────────────

program
  .command('adapters')
  .argument('[query]', 'Search keyword or site name (e.g. "npm", "search", "hackernews/top")')
  .option('-f, --format <fmt>', 'Output format: text, json', 'text')
  .option('-s, --strategy <strategy>', 'Filter by strategy: public, local, cookie, ui, intercept')
  .description('List or search available opencli adapters')
  .action(async (query: string | undefined, opts: { format?: string; strategy?: string }) => {
    await bootstrap();
    const { getRegistry, Strategy } = await import('@jackwener/opencli/registry');
    const registry = getRegistry();

    let commands = Array.from(registry.values());

    if (opts.strategy) {
      const s = opts.strategy.toLowerCase();
      commands = commands.filter(c => {
        const cs = String(c.strategy ?? (c.browser ? Strategy.COOKIE : Strategy.PUBLIC)).toLowerCase();
        return cs === s;
      });
    }

    if (query) {
      const q = query.toLowerCase();
      if (query.includes('/')) {
        commands = commands.filter(c => `${c.site}/${c.name}`.toLowerCase().includes(q));
      } else {
        commands = commands.filter(c =>
          c.site.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q) ||
          (c.description && c.description.toLowerCase().includes(q))
        );
      }
    }

    if (opts.format === 'json') {
      const output = commands.map(c => ({
        adapter: `${c.site}/${c.name}`,
        strategy: String(c.strategy ?? (c.browser ? Strategy.COOKIE : Strategy.PUBLIC)),
        access: c.access,
        description: c.description,
        args: c.args.map(a => a.name),
        columns: c.columns ?? [],
      }));
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    if (commands.length === 0) {
      console.log(query ? `No adapters matching "${query}".` : 'No adapters found.');
      return;
    }

    const grouped = new Map<string, typeof commands>();
    for (const c of commands) {
      const list = grouped.get(c.site) ?? [];
      list.push(c);
      grouped.set(c.site, list);
    }

    console.log(`\n${commands.length} adapters${query ? ` matching "${query}"` : ''}${opts.strategy ? ` [${opts.strategy}]` : ''}:\n`);
    for (const [site, cmds] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const c of cmds) {
        const strategy = String(c.strategy ?? (c.browser ? Strategy.COOKIE : Strategy.PUBLIC));
        const color = strategy === 'public' ? ANSI.green : strategy === 'local' ? ANSI.cyan : ANSI.yellow;
        const desc = c.description ? ` — ${c.description.slice(0, 60)}` : '';
        console.log(`  ${`${c.site}/${c.name}`.padEnd(30)} ${color}[${strategy}]${ANSI.reset}${desc}`);
      }
    }
  });

program.parse();
