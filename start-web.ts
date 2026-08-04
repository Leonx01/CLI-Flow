import { createWebServer } from './src/web/server.js';
import { parseWorkflow } from './src/schema/parser.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load adapters from opencli
const { discoverClis, discoverPlugins } = await import('./node_modules/@jackwener/opencli/dist/src/discovery.js');
const BUILTIN_CLIS = path.join(__dirname, 'node_modules/@jackwener/opencli/clis');
console.log('Loading adapters from:', BUILTIN_CLIS);
await discoverClis(BUILTIN_CLIS);
await discoverPlugins();

const { getRegistry } = await import('./node_modules/@jackwener/opencli/dist/src/registry.js');
console.log('Registered adapters:', getRegistry().size);

const def = parseWorkflow('workflows/setup-github-app-agent.yaml');
const server = await createWebServer({ definition: def });
console.log(`Web UI → http://localhost:${server.port}`);
