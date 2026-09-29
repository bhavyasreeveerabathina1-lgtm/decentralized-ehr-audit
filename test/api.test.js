import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createApp } from '../src/api.js';
import { createSystem } from '../src/system.js';
import { EncryptedBlobStore } from '../src/store.js';

let system;
let server;
let base;
let tempDir;
let store;

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'ehr-audit-test-'));
  store = new EncryptedBlobStore(tempDir);
  system = await createSystem();
  server = createServer(createApp({ ...system, store }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (system) await system.chain.disconnect();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function call(route, role, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { ...(role ? { 'x-demo-actor': role } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json() };
}

const syntheticRequest = {
  synthetic: true,
  patientRef: 'patient-demo-001',
  payload: { recordType: 'lab', date: '2026-09-29', provider: 'Synthetic Clinic', diagnosisCode: 'LAB-42', summary: 'Synthetic result within reference range.' }
};

test('consent-gated EHR audit API protects encrypted synthetic data and records an audit trail', async () => {
  const rejected = await call('/api/records', 'patient', { method: 'POST', body: JSON.stringify({ ...syntheticRequest, synthetic: false }) });
  assert.equal(rejected.status, 400);
  const invalidDate = await call('/api/records', 'patient', { method: 'POST', body: JSON.stringify({ ...syntheticRequest, payload: { ...syntheticRequest.payload, date: '2026-02-31' } }) });
  assert.equal(invalidDate.status, 400);

  const created = await call('/api/records', 'patient', { method: 'POST', body: JSON.stringify(syntheticRequest) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.recordId, /^0x[0-9a-f]{64}$/i);

  const storedEnvelope = JSON.parse(await readFile(store.fileFor(created.body.recordId), 'utf8'));
  assert.equal(storedEnvelope.algorithm, 'AES-256-GCM');
  assert.equal(JSON.stringify(storedEnvelope).includes('Synthetic result'), false);

  const denied = await call(`/api/records/${created.body.recordId}/access`, 'doctor');
  assert.equal(denied.status, 403);

  const grant = await call(`/api/records/${created.body.recordId}/consent`, 'patient', {
    method: 'POST', body: JSON.stringify({ grantee: 'doctor', expiresInSeconds: 3600 })
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));

  const verify = await call(`/api/records/${created.body.recordId}/verify`, 'doctor');
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  assert.equal(verify.body.integrity, 'verified');
  assert.equal(verify.body.dataReturned, false);

  const retrieve = await call(`/api/records/${created.body.recordId}/access`, 'doctor');
  assert.equal(retrieve.status, 200, JSON.stringify(retrieve.body));
  assert.equal(retrieve.body.payload.summary, syntheticRequest.payload.summary);
  assert.equal(retrieve.body.commitmentSalt, verify.body.commitmentSalt);

  const tampered = { ...storedEnvelope, ciphertext: `${storedEnvelope.ciphertext.slice(0, -2)}00` };
  await store.put(created.body.recordId, tampered);
  const integrityFailure = await call(`/api/records/${created.body.recordId}/access`, 'doctor');
  assert.equal(integrityFailure.status, 409);
  await store.put(created.body.recordId, storedEnvelope);

  const revoke = await call(`/api/records/${created.body.recordId}/revoke/doctor`, 'patient', { method: 'POST' });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
  const deniedAfterRevoke = await call(`/api/records/${created.body.recordId}/access`, 'doctor');
  assert.equal(deniedAfterRevoke.status, 403);

  const audit = await call(`/api/records/${created.body.recordId}/audit`);
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  const eventTypes = audit.body.events.map((event) => event.type);
  assert.ok(eventTypes.includes('RecordCreated'));
  assert.ok(eventTypes.includes('AccessGranted'));
  assert.ok(eventTypes.includes('AccessRevoked'));
  assert.equal(eventTypes.filter((type) => type === 'RecordAccessed').length, 2);
});
