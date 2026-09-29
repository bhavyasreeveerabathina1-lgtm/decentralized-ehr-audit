import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { ZeroHash, keccak256, toUtf8Bytes } from 'ethers';
import { createApp } from '../src/api.js';
import { createSystem } from '../src/system.js';
import { EncryptedBlobStore } from '../src/store.js';

process.env.EHR_MASTER_KEY = 'a'.repeat(64); // deterministic test-only secret; never a deployment value
let system;
let server;
let base;
let tempDir;
let store;

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'ehr-audit-test-'));
  store = new EncryptedBlobStore(tempDir);
  system = await createSystem();
  server = createServer(createApp({ ...system, store, demoAuthEnabled: true }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (system) await system.chain.disconnect();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function callAt(targetBase, route, role, options = {}) {
  const response = await fetch(`${targetBase}${route}`, {
    ...options,
    headers: { ...(role ? { 'x-demo-actor': role } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json() };
}
const call = (route, role, options) => callAt(base, route, role, options);

const syntheticRequest = {
  synthetic: true,
  patientRef: 'patient-demo-001',
  payload: { recordType: 'lab', date: '2026-09-29', provider: 'Synthetic Clinic', diagnosisCode: 'LAB-42', summary: 'Synthetic result within reference range.' }
};

test('demo role selection is disabled unless explicitly enabled', async () => {
  const disabledServer = createServer(createApp({ ...system, store, demoAuthEnabled: false }));
  await new Promise((resolve) => disabledServer.listen(0, '127.0.0.1', resolve));
  try {
    const targetBase = `http://127.0.0.1:${disabledServer.address().port}`;
    assert.equal((await callAt(targetBase, '/api/records', 'patient', { method: 'POST', body: JSON.stringify(syntheticRequest) })).status, 503);
    assert.equal((await callAt(targetBase, '/api/demo/accounts')).status, 503);
  } finally {
    await new Promise((resolve) => disabledServer.close(resolve));
  }
});

test('contract rejects a missing plaintext or ciphertext commitment', async () => {
  const patientId = keccak256(toUtf8Bytes('patient-id'));
  const blobHash = keccak256(toUtf8Bytes('blob'));
  const contentCommitment = keccak256(toUtf8Bytes('content'));
  const idOne = keccak256(toUtf8Bytes('zero-data-hash'));
  const idTwo = keccak256(toUtf8Bytes('zero-blob-hash'));
  await assert.rejects(system.contract.connect(system.signers[0]).createRecord(idOne, patientId, ZeroHash, blobHash));
  await assert.rejects(system.contract.connect(system.signers[0]).createRecord(idTwo, patientId, contentCommitment, ZeroHash));
});

test('consent-gated EHR audit API protects encrypted synthetic data and records caller-reported audit events', async () => {
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
  assert.match(verify.body.auditSemantics, /caller report, not independent proof/);

  const retrieve = await call(`/api/records/${created.body.recordId}/access`, 'doctor');
  assert.equal(retrieve.status, 200, JSON.stringify(retrieve.body));
  assert.equal(retrieve.body.payload.summary, syntheticRequest.payload.summary);
  assert.equal(retrieve.body.commitmentSalt, verify.body.commitmentSalt);

  const tampered = { ...storedEnvelope, ciphertext: `${storedEnvelope.ciphertext.slice(0, -2)}00` };
  await store.put(created.body.recordId, tampered);
  const integrityFailure = await call(`/api/records/${created.body.recordId}/access`, 'doctor');
  assert.equal(integrityFailure.status, 409);
  await store.put(created.body.recordId, storedEnvelope);

  await system.provider.send('evm_increaseTime', [3601]);
  await system.provider.send('evm_mine', []);
  const deniedAfterExpiry = await call(`/api/records/${created.body.recordId}/access`, 'doctor');
  assert.equal(deniedAfterExpiry.status, 403);

  const revoke = await call(`/api/records/${created.body.recordId}/revoke/doctor`, 'patient', { method: 'POST' });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
  const deniedAfterRevoke = await call(`/api/records/${created.body.recordId}/access`, 'doctor');
  assert.equal(deniedAfterRevoke.status, 403);

  const audit = await call(`/api/records/${created.body.recordId}/audit`, 'patient');
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  const eventTypes = audit.body.events.map((event) => event.type);
  assert.ok(eventTypes.includes('RecordCreated'));
  assert.ok(eventTypes.includes('AccessGranted'));
  assert.ok(eventTypes.includes('AccessRevoked'));
  assert.equal(eventTypes.filter((type) => type === 'AccessReported').length, 2);
  assert.equal(eventTypes.includes('RecordAccessed'), false);
});

test('unknown record IDs return 404 instead of an internal server error', async () => {
  const unknownId = `0x${'9'.repeat(64)}`;
  const routes = [
    [`/api/records/${unknownId}/verify`, 'doctor'],
    [`/api/records/${unknownId}/access`, 'doctor'],
    [`/api/records/${unknownId}/audit`, 'patient'],
    [`/api/records/${unknownId}/consent`, 'patient', { method: 'POST', body: JSON.stringify({ grantee: 'doctor', expiresInSeconds: 3600 }) }],
    [`/api/records/${unknownId}/revoke/doctor`, 'patient', { method: 'POST' }]
  ];
  for (const [route, role, options] of routes) {
    const response = await call(route, role, options);
    assert.equal(response.status, 404, `${route}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, 'record not found');
  }
});

test('failed ledger creation removes ciphertext when the ledger confirms no record exists', async () => {
  const beforeFiles = await readdir(tempDir);
  const failure = Object.assign(new Error('simulated transaction failure'), { shortMessage: 'simulated transaction failure' });
  const unavailableContract = {
    connect() { return { async createRecord() { throw failure; } }; },
    async getRecord() { throw Object.assign(new Error('execution reverted: unknown record'), { reason: 'unknown record' }); }
  };
  const failedServer = createServer(createApp({ contract: unavailableContract, signers: system.signers, store, demoAuthEnabled: true }));
  await new Promise((resolve) => failedServer.listen(0, '127.0.0.1', resolve));
  try {
    const targetBase = `http://127.0.0.1:${failedServer.address().port}`;
    const response = await callAt(targetBase, '/api/records', 'patient', { method: 'POST', body: JSON.stringify(syntheticRequest) });
    assert.equal(response.status, 502);
    assert.match(response.body.error, /ledger transaction failed/);
    assert.deepEqual(await readdir(tempDir), beforeFiles);
  } finally {
    await new Promise((resolve) => failedServer.close(resolve));
  }
});

test('direct contract callers create only AccessReported self-assertions', async () => {
  const created = await call('/api/records', 'patient', { method: 'POST', body: JSON.stringify(syntheticRequest) });
  assert.equal(created.status, 201);
  // The contract can enforce ownership/consent, but cannot inspect off-chain storage.
  await (await system.contract.connect(system.signers[0]).reportAccess(created.body.recordId)).wait();
  const reported = await system.contract.queryFilter(system.contract.filters.AccessReported(created.body.recordId));
  assert.equal(reported.length, 1);
  assert.equal(reported[0].fragment.name, 'AccessReported');
});
