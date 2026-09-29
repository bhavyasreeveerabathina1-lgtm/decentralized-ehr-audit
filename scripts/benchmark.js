import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { contentHash, deriveKey, encryptRecord, envelopeHash } from '../src/crypto.js';
import { createApp } from '../src/api.js';
import { EncryptedBlobStore } from '../src/store.js';
import { createSystem } from '../src/system.js';

const DATASET = Object.freeze({
  name: 'MIMIC-IV Clinical Database Demo',
  release: '2.2',
  url: 'https://physionet.org/content/mimic-iv-demo/2.2/',
  registry: 'https://registry.opendata.aws/mimic-iv-demo/',
  license: 'Open Data Commons Open Database License v1.0 (ODbL-1.0)'
});
const DEFAULT_FIXTURE_COUNT = 12;
const BOOTSTRAP_ROUNDS = 1000;

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') {
      if (field.length !== 0) throw new Error('Invalid CSV: quote inside an unquoted field');
      quoted = true;
    } else if (char === ',') {
      row.push(field); field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error('Invalid CSV: unterminated quoted field');
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  if (rows.length === 0) return [];
  const headers = rows.shift().map((header, index) => index === 0 ? header.replace(/^\uFEFF/, '') : header);
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) throw new Error('Invalid CSV: empty or duplicate header');
  return rows.map((values) => {
    if (values.length !== headers.length) throw new Error('Invalid CSV: row has a different number of columns than its header');
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

async function findCsvFile(directory, name) {
  for (const candidate of [path.join(directory, name), path.join(directory, `${name}.gz`)]) {
    try { await stat(candidate); return candidate; }
    catch { /* try compressed or uncompressed spelling */ }
  }
  throw new Error('CSV input is missing');
}

async function readCsvFile(directory, name) {
  const filename = await findCsvFile(directory, name);
  const contents = await readFile(filename);
  const text = filename.endsWith('.gz') ? gunzipSync(contents).toString('utf8') : contents.toString('utf8');
  return parseCsv(text);
}

async function locateHospDirectory(inputDirectory) {
  if (!inputDirectory) throw new Error('MIMIC demo input directory is required with --input');
  const resolved = path.resolve(inputDirectory);
  for (const candidate of [path.join(resolved, 'hosp'), path.join(resolved, 'mimic-iv-demo-2.2', 'hosp'), resolved]) {
    try {
      await Promise.all(['patients.csv', 'admissions.csv', 'diagnoses_icd.csv'].map((name) => findCsvFile(candidate, name)));
      return candidate;
    } catch { /* try the next documented extraction layout */ }
  }
  throw new Error('MIMIC demo files not found; provide a directory containing hosp/patients.csv[.gz], admissions.csv[.gz], and diagnoses_icd.csv[.gz]');
}

export async function loadMimicDemoRecords(inputDirectory, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('MIMIC demo record limit must be from 1 through 100');
  const hosp = await locateHospDirectory(inputDirectory);
  const [patients, admissions, diagnoses] = await Promise.all([
    readCsvFile(hosp, 'patients.csv'),
    readCsvFile(hosp, 'admissions.csv'),
    readCsvFile(hosp, 'diagnoses_icd.csv')
  ]);
  for (const [rows, fields, file] of [
    [patients, ['subject_id'], 'patients.csv'],
    [admissions, ['subject_id', 'hadm_id', 'admittime', 'admission_type'], 'admissions.csv'],
    [diagnoses, ['hadm_id', 'seq_num', 'icd_code'], 'diagnoses_icd.csv']
  ]) {
    if (rows.length === 0 || fields.some((field) => !(field in rows[0]))) throw new Error(`Unexpected MIMIC demo schema in ${file}`);
  }
  // Source identifiers are used only in transient in-memory joins; they are never
  // copied into benchmark payloads, output files, logs, or committed artifacts.
  const firstAdmission = new Map();
  for (const admission of admissions) {
    if (admission.subject_id && !firstAdmission.has(admission.subject_id)) firstAdmission.set(admission.subject_id, admission);
  }
  const primaryDiagnosis = new Map();
  for (const diagnosis of diagnoses) {
    if (!diagnosis.hadm_id || !diagnosis.icd_code) continue;
    const current = primaryDiagnosis.get(diagnosis.hadm_id);
    const sequence = Number(diagnosis.seq_num);
    if (!current || (Number.isFinite(sequence) && sequence < current.sequence)) primaryDiagnosis.set(diagnosis.hadm_id, { sequence, code: diagnosis.icd_code });
  }
  const records = [];
  for (const patient of patients) {
    const admission = firstAdmission.get(patient.subject_id);
    if (!admission) continue;
    const date = admission.admittime.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('MIMIC demo contains an invalid admission date');
    const diagnosisCode = primaryDiagnosis.get(admission.hadm_id)?.code || 'UNSPECIFIED';
    records.push({
      patientRef: `bench-${randomUUID()}`,
      payload: {
        recordType: 'encounter',
        date,
        provider: 'Beth Israel Deaconess Medical Center (MIMIC-IV demo)',
        diagnosisCode,
        summary: `De-identified demo admission class: ${admission.admission_type || 'not recorded'}`
      }
    });
    if (records.length === limit) break;
  }
  if (records.length === 0) throw new Error('No usable patient-admission rows found in the supplied MIMIC demo files');
  return records;
}

export function makeSyntheticRecords(count = DEFAULT_FIXTURE_COUNT) {
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('Synthetic record count must be from 1 through 1000');
  return Array.from({ length: count }, (_, index) => ({
    patientRef: `synthetic-benchmark-${String(index + 1).padStart(4, '0')}`,
    payload: {
      recordType: index % 3 === 0 ? 'lab' : 'encounter',
      date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
      provider: 'Synthetic Benchmark Clinic',
      diagnosisCode: `SYN-${String(index + 1).padStart(4, '0')}`,
      summary: `Synthetic benchmark fixture ${index + 1}; no clinical interpretation.`
    }
  }));
}

function percentile(sorted, value) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * value;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + ((sorted[Math.ceil(position)] - sorted[lower]) * fraction);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function summarizeSamples(values, unit = 'ms') {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Cannot summarize an empty or invalid measurement sample');
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const median = percentile(sorted, 0.5);
  const random = seededRandom(0xC0FFEE);
  const bootstrappedMedians = [];
  for (let round = 0; round < BOOTSTRAP_ROUNDS; round += 1) {
    const sample = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]).sort((a, b) => a - b);
    bootstrappedMedians.push(percentile(sample, 0.5));
  }
  bootstrappedMedians.sort((a, b) => a - b);
  const rounded = (number) => Number(number.toFixed(3));
  return {
    n: values.length,
    unit,
    mean: rounded(mean),
    p50: rounded(median),
    p95: rounded(percentile(sorted, 0.95)),
    bootstrap_95pct_ci_for_median: [rounded(percentile(bootstrappedMedians, 0.025)), rounded(percentile(bootstrappedMedians, 0.975))]
  };
}

function summarizeBytes(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: values.length, mean: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)), p95: Number(percentile(sorted, 0.95).toFixed(1)), unit: 'bytes' };
}

function summarizeGas(values) {
  if (values.length === 0) return null;
  const result = summarizeSamples(values, 'gas');
  return { n: result.n, mean: Math.round(result.mean), p50: Math.round(result.p50), p95: Math.round(result.p95) };
}

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

function makeBaselineContract(signers) {
  const records = new Map();
  const access = new Map();
  const recordKey = (id) => id.toLowerCase();
  const addressKey = (address) => address.toLowerCase();
  const grantKey = (id, address) => `${recordKey(id)}:${addressKey(address)}`;
  const unknown = () => Object.assign(new Error('unknown record'), { reason: 'unknown record' });
  const fakeTransaction = () => ({ wait: async () => ({ hash: `0x${randomBytes(32).toString('hex')}` }) });
  const connected = (signer) => ({
    async createRecord(id, patientId, dataHash, encryptedBlobHash) {
      const key = recordKey(id);
      if (records.has(key)) throw new Error('record already exists');
      records.set(key, { patient: await signer.getAddress(), patientId, dataHash, encryptedBlobHash });
      return fakeTransaction();
    },
    async grantAccess(id, grantee, expiresAt) {
      const record = records.get(recordKey(id));
      if (!record) throw unknown();
      if (addressKey(record.patient) !== addressKey(await signer.getAddress())) throw new Error('patient only');
      access.set(grantKey(id, grantee), Number(expiresAt));
      return fakeTransaction();
    },
    async revokeAccess(id, grantee) {
      const record = records.get(recordKey(id));
      if (!record) throw unknown();
      if (addressKey(record.patient) !== addressKey(await signer.getAddress())) throw new Error('patient only');
      access.delete(grantKey(id, grantee));
      return fakeTransaction();
    },
    async reportAccess(id) {
      if (!(await contract.hasAccess(id, await signer.getAddress()))) throw new Error('access not granted');
      return fakeTransaction();
    }
  });
  const contract = {
    connect: connected,
    async getRecord(id) {
      const record = records.get(recordKey(id));
      if (!record) throw unknown();
      return [record.patient, record.patientId, record.dataHash, record.encryptedBlobHash];
    },
    async hasAccess(id, actor) {
      const record = records.get(recordKey(id));
      if (!record) throw unknown();
      if (addressKey(record.patient) === addressKey(actor)) return true;
      return (access.get(grantKey(id, actor)) || 0) > Math.floor(Date.now() / 1000);
    }
  };
  return {
    contract,
    estimatedMetadataBytesPerRecord() {
      if (records.size === 0) return 0;
      const total = [...records.entries()].reduce((sum, [id, record]) => sum + Buffer.byteLength(JSON.stringify({ id, ...record })), 0);
      return Number((total / records.size).toFixed(1));
    }
  };
}

async function openServer(app) {
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function apiCall(base, route, role, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { ...(role ? { 'x-demo-actor': role } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  let body;
  try { body = await response.json(); } catch { throw new Error('Benchmark API returned a non-JSON response'); }
  return { status: response.status, body };
}

function assertStatus(result, expected, stage) {
  if (result.status !== expected) throw new Error(`Benchmark ${stage} failed (HTTP ${result.status}, expected ${expected})`);
}

async function txGas(system, txHash) {
  const receipt = await system.provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error('Benchmark transaction receipt was not available');
  return Number(receipt.gasUsed);
}

async function creationGas(system, recordId) {
  const events = await system.contract.queryFilter(system.contract.filters.RecordCreated(recordId));
  const event = events.at(-1);
  if (!event) throw new Error('Benchmark record creation event was not available');
  return txGas(system, event.transactionHash);
}

async function runChainPath(records, key, patientIdKey, realData) {
  const system = await createSystem();
  const storeDir = await mkdtemp(path.join(os.tmpdir(), 'ehr-bench-chain-store-'));
  const store = new EncryptedBlobStore(storeDir);
  const { server, base } = await openServer(createApp({ ...system, store, key, patientIdKey, demoAuthEnabled: true, allowMimicDemoData: realData }));
  const phases = Object.fromEntries(['create', 'deny_before_grant', 'grant', 'verify', 'access', 'tamper_detection', 'revoke', 'deny_after_revoke'].map((name) => [name, []]));
  const gas = Object.fromEntries(['create', 'grant', 'verify', 'access', 'revoke'].map((name) => [name, []]));
  const blobSizes = [];
  let successfulDenialsBefore = 0;
  let successfulDenialsAfter = 0;
  let grants = 0;
  let revocations = 0;
  let tamperDetections = 0;
  const pipelineStart = performance.now();
  try {
    for (const record of records) {
      const patientRequest = { synthetic: !realData, ...(realData ? { source: 'mimic-demo' } : {}), patientRef: record.patientRef, payload: record.payload };
      const create = await timed(() => apiCall(base, '/api/records', 'patient', { method: 'POST', body: JSON.stringify(patientRequest) }));
      assertStatus(create.value, 201, 'create');
      const recordId = create.value.body.recordId;
      phases.create.push(create.ms);
      gas.create.push(await creationGas(system, recordId));
      const envelopePath = store.fileFor(recordId);
      blobSizes.push((await stat(envelopePath)).size);

      const denied = await timed(() => apiCall(base, `/api/records/${recordId}/access`, 'doctor'));
      assertStatus(denied.value, 403, 'pre-consent denial');
      if (!('payload' in denied.value.body)) successfulDenialsBefore += 1;
      phases.deny_before_grant.push(denied.ms);

      const grant = await timed(() => apiCall(base, `/api/records/${recordId}/consent`, 'patient', { method: 'POST', body: JSON.stringify({ grantee: 'doctor', expiresInSeconds: 3600 }) }));
      assertStatus(grant.value, 200, 'grant');
      grants += 1;
      phases.grant.push(grant.ms);
      gas.grant.push(await txGas(system, grant.value.body.transactionHash));

      const verify = await timed(() => apiCall(base, `/api/records/${recordId}/verify`, 'doctor'));
      assertStatus(verify.value, 200, 'verify');
      if (verify.value.body.integrity !== 'verified' || verify.value.body.dataReturned !== false) throw new Error('Benchmark integrity verification returned an unexpected result');
      phases.verify.push(verify.ms);
      gas.verify.push(await txGas(system, verify.value.body.transactionHash));

      const access = await timed(() => apiCall(base, `/api/records/${recordId}/access`, 'doctor'));
      assertStatus(access.value, 200, 'authorized access');
      if (access.value.body.integrity !== 'verified' || access.value.body.payload.recordType !== record.payload.recordType) throw new Error('Benchmark authorized retrieval returned an unexpected result');
      phases.access.push(access.ms);
      gas.access.push(await txGas(system, access.value.body.auditTransaction));

      const originalEnvelope = await store.get(recordId);
      const ciphertext = originalEnvelope.ciphertext;
      const finalByte = Number.parseInt(ciphertext.slice(-2), 16) ^ 1;
      await store.put(recordId, { ...originalEnvelope, ciphertext: `${ciphertext.slice(0, -2)}${finalByte.toString(16).padStart(2, '0')}` });
      const tamper = await timed(() => apiCall(base, `/api/records/${recordId}/access`, 'doctor'));
      assertStatus(tamper.value, 409, 'tamper detection');
      tamperDetections += 1;
      phases.tamper_detection.push(tamper.ms);
      await store.put(recordId, originalEnvelope);

      const revoke = await timed(() => apiCall(base, `/api/records/${recordId}/revoke/doctor`, 'patient', { method: 'POST' }));
      assertStatus(revoke.value, 200, 'revoke');
      revocations += 1;
      phases.revoke.push(revoke.ms);
      gas.revoke.push(await txGas(system, revoke.value.body.transactionHash));

      const deniedAgain = await timed(() => apiCall(base, `/api/records/${recordId}/access`, 'doctor'));
      assertStatus(deniedAgain.value, 403, 'post-revocation denial');
      if (!('payload' in deniedAgain.value.body)) successfulDenialsAfter += 1;
      phases.deny_after_revoke.push(deniedAgain.ms);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await system.chain.disconnect();
    await rm(storeDir, { recursive: true, force: true });
  }
  const elapsedSeconds = (performance.now() - pipelineStart) / 1000;
  return {
    phases: Object.fromEntries(Object.entries(phases).map(([name, values]) => [name, summarizeSamples(values)])),
    gas: Object.fromEntries(Object.entries(gas).map(([name, values]) => [name, summarizeGas(values)])),
    encrypted_blob_bytes: summarizeBytes(blobSizes),
    pipeline_records_per_second: Number((records.length / elapsedSeconds).toFixed(3)),
    behavior: { consent_grants_succeeded: grants, pre_grant_denials: successfulDenialsBefore, integrity_tampering_detected: tamperDetections, revocations_succeeded: revocations, post_revocation_denials: successfulDenialsAfter }
  };
}

async function runBaselinePath(records, key, patientIdKey, realData) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ehr-bench-baseline-store-'));
  const store = new EncryptedBlobStore(tempDir);
  const provider = { getBlock: async () => ({ timestamp: Math.floor(Date.now() / 1000) }) };
  const signers = Array.from({ length: 3 }, () => {
    const address = `0x${randomBytes(20).toString('hex')}`;
    return { provider, getAddress: async () => address };
  });
  const baselineLedger = makeBaselineContract(signers);
  const serverContext = await openServer(createApp({ contract: baselineLedger.contract, signers, store, key, patientIdKey, demoAuthEnabled: true, allowMimicDemoData: realData }));
  const { server, base } = serverContext;
  const phases = Object.fromEntries(['create', 'deny_before_grant', 'grant', 'verify', 'access', 'tamper_detection', 'revoke', 'deny_after_revoke'].map((name) => [name, []]));
  const blobSizes = [];
  const pipelineStart = performance.now();
  let successfulDenialsBefore = 0;
  let successfulDenialsAfter = 0;
  let grants = 0;
  let revocations = 0;
  let tamperDetections = 0;
  try {
    for (const record of records) {
      const patientRequest = { synthetic: !realData, ...(realData ? { source: 'mimic-demo' } : {}), patientRef: record.patientRef, payload: record.payload };
      const create = await timed(() => apiCall(base, '/api/records', 'patient', { method: 'POST', body: JSON.stringify(patientRequest) }));
      assertStatus(create.value, 201, 'baseline create');
      const recordId = create.value.body.recordId;
      phases.create.push(create.ms);
      blobSizes.push((await stat(store.fileFor(recordId))).size);

      const denied = await timed(() => apiCall(base, `/api/records/${recordId}/access`, 'doctor'));
      assertStatus(denied.value, 403, 'baseline pre-consent denial');
      if (!('payload' in denied.value.body)) successfulDenialsBefore += 1;
      phases.deny_before_grant.push(denied.ms);

      const grant = await timed(() => apiCall(base, `/api/records/${recordId}/consent`, 'patient', { method: 'POST', body: JSON.stringify({ grantee: 'doctor', expiresInSeconds: 3600 }) }));
      assertStatus(grant.value, 200, 'baseline grant');
      grants += 1;
      phases.grant.push(grant.ms);

      const verify = await timed(() => apiCall(base, `/api/records/${recordId}/verify`, 'doctor'));
      assertStatus(verify.value, 200, 'baseline verify');
      if (verify.value.body.integrity !== 'verified' || verify.value.body.dataReturned !== false) throw new Error('Baseline integrity verification returned an unexpected result');
      phases.verify.push(verify.ms);

      const access = await timed(() => apiCall(base, `/api/records/${recordId}/access`, 'doctor'));
      assertStatus(access.value, 200, 'baseline authorized access');
      if (access.value.body.integrity !== 'verified' || access.value.body.payload.recordType !== record.payload.recordType) throw new Error('Baseline authorized retrieval returned an unexpected result');
      phases.access.push(access.ms);

      const originalEnvelope = await store.get(recordId);
      const ciphertext = originalEnvelope.ciphertext;
      const finalByte = Number.parseInt(ciphertext.slice(-2), 16) ^ 1;
      await store.put(recordId, { ...originalEnvelope, ciphertext: `${ciphertext.slice(0, -2)}${finalByte.toString(16).padStart(2, '0')}` });
      const tamper = await timed(() => apiCall(base, `/api/records/${recordId}/access`, 'doctor'));
      assertStatus(tamper.value, 409, 'baseline tamper detection');
      tamperDetections += 1;
      phases.tamper_detection.push(tamper.ms);
      await store.put(recordId, originalEnvelope);

      const revoke = await timed(() => apiCall(base, `/api/records/${recordId}/revoke/doctor`, 'patient', { method: 'POST' }));
      assertStatus(revoke.value, 200, 'baseline revoke');
      revocations += 1;
      phases.revoke.push(revoke.ms);

      const deniedAgain = await timed(() => apiCall(base, `/api/records/${recordId}/access`, 'doctor'));
      assertStatus(deniedAgain.value, 403, 'baseline post-revocation denial');
      if (!('payload' in deniedAgain.value.body)) successfulDenialsAfter += 1;
      phases.deny_after_revoke.push(deniedAgain.ms);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
  const elapsedSeconds = (performance.now() - pipelineStart) / 1000;
  return {
    phases: Object.fromEntries(Object.entries(phases).map(([name, values]) => [name, summarizeSamples(values)])),
    encrypted_blob_bytes: summarizeBytes(blobSizes),
    pipeline_records_per_second: Number((records.length / elapsedSeconds).toFixed(3)),
    behavior: { consent_grants_succeeded: grants, pre_grant_denials: successfulDenialsBefore, integrity_tampering_detected: tamperDetections, revocations_succeeded: revocations, post_revocation_denials: successfulDenialsAfter },
    in_memory_metadata_json_bytes_per_record_estimate: baselineLedger.estimatedMetadataBytesPerRecord()
  };
}

export async function runBenchmark({ source = 'synthetic', inputDirectory, records: requestedRecords, recordedAt = new Date().toISOString() } = {}) {
  const sampleRecords = source === 'mimic-demo'
    ? await loadMimicDemoRecords(inputDirectory, requestedRecords ?? 100)
    : source === 'synthetic'
      ? makeSyntheticRecords(requestedRecords ?? DEFAULT_FIXTURE_COUNT)
      : (() => { throw new Error('Benchmark source must be synthetic or mimic-demo'); })();
  const key = randomBytes(32);
  const patientIdKey = deriveKey(key.toString('hex'), 'patient-pseudonym-v1');
  const realData = source === 'mimic-demo';
  const chain = await runChainPath(sampleRecords, key, patientIdKey, realData);
  const baseline = await runBaselinePath(sampleRecords, key, patientIdKey, realData);
  const result = {
    schema_version: '1.0',
    recorded_at: recordedAt,
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    source: realData ? { name: DATASET.name, release: DATASET.release, url: DATASET.url, registry: DATASET.registry, license: DATASET.license, attribution: `${DATASET.name}, accessed ${new Date(recordedAt).toISOString().slice(0, 10)} from ${DATASET.registry}; documentation DOI 10.13026/dp1f-ex47.`, raw_data_included: false } : { name: 'Bundled synthetic benchmark fixtures', raw_data_included: false },
    protocol: { records: sampleRecords.length, sequential_records: true, tamper_trials_per_record: 1, bootstrap_rounds: BOOTSTRAP_ROUNDS, confidence_interval: 'Deterministic nonparametric bootstrap 95% interval for the sample median; describes per-operation variation in this run only, not population or cross-deployment uncertainty.' },
    measurements: {
      local_evm: { ...chain, estimated_evm_record_state_bytes_per_record: 160, estimated_evm_active_grant_storage_bytes_per_record: 32, evm_state_estimate_note: 'Five 32-byte storage slots for the record struct (patient address, patient ID, data hash, encrypted-blob hash, and exists flag); one additional 32-byte mapping slot while a consent grant is active. Excludes trie, block, and event-log overhead.' },
      no_blockchain_baseline: { ...baseline, baseline_note: 'Same Express routes, payloads, AES-GCM encryption, local encrypted file store, consent checks, and integrity checks; grant state is an in-process map and has no signatures, consensus, or chain transaction.' }
    },
    interpretation: { clinical_prediction_evaluated: false, decentralized_consensus_evaluated: false, dollar_costs: 'Not measured: the chain is a local Hardhat EVM with no network fees.', confidence_scope: 'CIs quantify only the observed per-operation sample variability in this one serial run; repeat runs on matched hardware are needed for deployment-level comparisons.' }
  };
  return result;
}

function parseArgs(argv) {
  const args = { source: 'synthetic' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    const names = { '--source': 'source', '--input': 'inputDirectory', '--records': 'records', '--output': 'output' };
    const name = names[arg];
    if (!name || !argv[index + 1]) throw new Error(`Unknown option or missing value: ${arg}`);
    const value = argv[++index];
    args[name] = name === 'records' ? Number(value) : value;
  }
  return args;
}

const HELP = `Privacy-preserving EHR authenticity benchmark\n\nUsage:\n  npm run benchmark -- [--source synthetic] [--records 12] [--output FILE]\n  npm run benchmark -- --source mimic-demo --input EXTRACTED_DATA_DIR [--records 100] [--output FILE]\n\nThe default path uses synthetic fixtures. The MIMIC-IV demo path reads de-identified rows only from a local extracted copy, writes no source rows or identifiers to output, and deletes temporary encrypted files on exit.\n`;

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(HELP); return; }
  const result = await runBenchmark(args);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    const outputPath = path.resolve(args.output);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(outputPath), { recursive: true }));
    const temporaryOutput = `${outputPath}.${process.pid}.tmp`;
    await writeFile(temporaryOutput, serialized, { mode: 0o600 });
    await rename(temporaryOutput, outputPath);
  }
  process.stdout.write(serialized);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Benchmark failed: ${error.message}`);
    process.exitCode = 1;
  });
}
