import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createApp } from '../src/api.js';
import { createSystem } from '../src/system.js';
import { EncryptedBlobStore } from '../src/store.js';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ehr-audit-demo-'));
const system = await createSystem();
const store = new EncryptedBlobStore(tempDir);
const app = createApp({ ...system, store });
const server = createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (pathName, role, options = {}) => {
  const response = await fetch(`${base}${pathName}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(role ? { 'x-demo-actor': role } : {}), ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
};

try {
  console.log('1. Create a synthetic lab record as the patient...');
  const created = await call('/api/records', 'patient', { method: 'POST', body: JSON.stringify({
    synthetic: true,
    patientRef: 'patient-demo-001',
    payload: { recordType: 'lab', date: '2026-09-29', provider: 'Example Clinic', diagnosisCode: 'LAB-A1', summary: 'Synthetic test result: within reference range.' }
  }) });
  console.log(`   Created ${created.recordId}; only hashes and a pseudonymous ID are on-chain.`);

  console.log('2. Confirm unauthorized access is denied...');
  const denied = await fetch(`${base}/api/records/${created.recordId}/access`, { headers: { 'x-demo-actor': 'doctor' } });
  console.log(`   Doctor without consent: HTTP ${denied.status} (expected 403).`);

  console.log('3. Patient grants short-lived doctor consent...');
  await call(`/api/records/${created.recordId}/consent`, 'patient', { method: 'POST', body: JSON.stringify({ grantee: 'doctor', expiresInSeconds: 3600 }) });

  console.log('4. Doctor verifies commitment, then retrieves decrypted synthetic record...');
  const verified = await call(`/api/records/${created.recordId}/verify`, 'doctor');
  const retrieved = await call(`/api/records/${created.recordId}/access`, 'doctor');
  console.log(`   Integrity: ${verified.integrity}; payload: ${retrieved.payload.summary}`);

  console.log('5. Patient revokes consent; subsequent doctor access is denied...');
  await call(`/api/records/${created.recordId}/revoke/doctor`, 'patient', { method: 'POST' });
  const afterRevoke = await fetch(`${base}/api/records/${created.recordId}/access`, { headers: { 'x-demo-actor': 'doctor' } });
  console.log(`   Doctor after revocation: HTTP ${afterRevoke.status} (expected 403).`);

  const audit = await call(`/api/records/${created.recordId}/audit`);
  console.log(`6. Audit trail contains ${audit.events.length} on-chain events: ${audit.events.map((event) => event.type).join(', ')}.`);
  console.log('\nDemo completed. See docs/threat-model.md and docs/security-notes.md for limitations.');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await system.chain.disconnect();
  await rm(tempDir, { recursive: true, force: true });
}
