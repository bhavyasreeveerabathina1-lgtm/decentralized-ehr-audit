import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from './api.js';
import { deriveKey } from './crypto.js';
import { EncryptedBlobStore } from './store.js';
import { createSystem } from './system.js';

if (process.env.EHR_ENABLE_DEMO_AUTH !== 'true') {
  throw new Error('Refusing to start: set EHR_ENABLE_DEMO_AUTH=true only for a local educational demo; role headers are not authentication.');
}
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  throw new Error('Refusing to bind the demo API beyond loopback; this prototype has no real authentication or TLS.');
}
const key = deriveKey();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ephemeralStoreDir = process.env.EHR_STORE_DIR ? null : await mkdtemp(path.join(os.tmpdir(), 'ehr-audit-'));
const storeDir = process.env.EHR_STORE_DIR || ephemeralStoreDir || path.join(root, 'data', 'encrypted-records');
const store = new EncryptedBlobStore(storeDir);
await store.initialize();
const system = await createSystem();
const app = createApp({ ...system, store, key, demoAuthEnabled: true });
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, host, async () => {
  const address = server.address();
  console.log(`EHR audit prototype listening at http://${host}:${address.port}`);
  console.log(`Contract: ${system.contractAddress}`);
  console.log('This starts a fresh local Hardhat chain; use synthetic data only.');
  if (ephemeralStoreDir) console.log('Encrypted record files are temporary and will be removed on shutdown.');
});

async function shutdown() {
  server.close();
  await system.chain.disconnect();
  if (ephemeralStoreDir) await rm(ephemeralStoreDir, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
