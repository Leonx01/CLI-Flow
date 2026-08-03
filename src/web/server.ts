import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { WebAdapter } from './adapter.js';
import { openInFileManager } from '../util/open-file.js';
import type { WorkflowDefinition } from '../schema/types.js';

export async function createWebServer({ definition }: { definition: WorkflowDefinition }) {
  const app = express();
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('error', (err) => console.error(`WebSocket error: ${err.message}`));
  const adapter = new WebAdapter(wss);

  // Whether this server process has started a run. Lets the page know not to
  // auto-run again after a reload (auto-run fires only once per process).
  let runStarted = false;

  app.use(express.json());

  // Serve Vite-built frontend
  app.use(express.static('dist/web'));

  // SPA fallback
  app.get('/', (_req, res) => {
    res.sendFile('dist/web/index.html', { root: '.' });
  });

  // API: get workflow definition
  app.get('/api/definition', (_req, res) => {
    res.json(definition);
  });

  // API: server process state (used by the auto-run button)
  app.get('/api/state', (_req, res) => {
    res.json({ runStarted });
  });

  // API: run workflow
  app.post('/api/run', async (req, res) => {
    try {
      runStarted = true;
      const { executeWorkflow } = await import('../engine/engine.js');
      const { getRegistry } = await import('@jackwener/opencli/registry');
      const callbacks = adapter.getCallbacks();
      // Log available adapters for debugging
      const all = [...getRegistry().keys()].filter((k: string) => k.startsWith('local/'));
      console.error(`[web] local adapters in registry: ${all.join(', ')}`);
      // Fire-and-forget: engine pushes progress via WebSocket
      executeWorkflow(definition, req.body?.inputs || {}, { callbacks, quiet: true })
        .then(result => {
          adapter.getCallbacks().onWorkflowEnd?.({ runId: result.id, status: result.status, finishedAt: result.finishedAt });
        })
        .catch(err => {
          const data = JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
        });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // API: submit interact answer
  app.post('/api/interact', (req, res) => {
    adapter.resolveInteract(req.body?.answer);
    res.json({ ok: true });
  });

  // API: reveal an output file in the OS file manager (server runs on the
  // same machine as the files). Path is resolved server-side; only files
  // that actually exist are opened.
  app.post('/api/open-output', async (req, res) => {
    try {
      const filePath = req.body?.path;
      if (typeof filePath !== 'string' || !filePath.trim()) {
        res.status(400).json({ ok: false, error: 'Missing path' });
        return;
      }
      await openInFileManager(filePath);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  const port = 3000;

  // Handle server errors gracefully
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Is another cliflow web server running?`);
    } else {
      console.error(`Web server error: ${err.message}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, () => resolve());
    httpServer.once('error', reject);
  }).catch(err => {
    console.error(`Failed to start web server: ${err.message}`);
    throw err;
  });

  return { port, adapter, httpServer };
}
