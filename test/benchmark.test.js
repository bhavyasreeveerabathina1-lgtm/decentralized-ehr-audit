import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { loadMimicDemoRecords, makeSyntheticRecords, parseCsv, runBenchmark, summarizeSamples } from '../scripts/benchmark.js';

test('CSV parser handles quoted commas, escaped quotes, CRLF, and embedded newlines', () => {
  assert.deepEqual(parseCsv('subject_id,note\r\n001,"has, comma"\r\n002,"says ""hello"""\r\n003,"line one\nline two"\r\n'), [
    { subject_id: '001', note: 'has, comma' },
    { subject_id: '002', note: 'says "hello"' },
    { subject_id: '003', note: 'line one\nline two' }
  ]);
  assert.throws(() => parseCsv('a,b\n1,"unterminated'), /unterminated/);
  assert.throws(() => parseCsv('a,a\n1,2'), /duplicate header/);
});

test('MIMIC demo loader maps only required encounter fields and never retains source identifiers in its output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ehr-benchmark-csv-test-'));
  const hosp = path.join(root, 'mimic-iv-demo-2.2', 'hosp');
  await mkdir(hosp, { recursive: true });
  await writeFile(path.join(hosp, 'patients.csv.gz'), gzipSync('subject_id,gender\n100001,F\n100002,M\n'));
  await writeFile(path.join(hosp, 'admissions.csv.gz'), gzipSync('subject_id,hadm_id,admittime,admission_type\n100001,200001,2150-01-02 12:00:00,URGENT\n100002,200002,2150-01-03 00:00:00,ELECTIVE\n'));
  await writeFile(path.join(hosp, 'diagnoses_icd.csv.gz'), gzipSync('hadm_id,seq_num,icd_code\n200001,2,SECONDARY\n200001,1,PRIMARY\n200002,1,OTHER\n'));
  try {
    const records = await loadMimicDemoRecords(root, 2);
    assert.equal(records.length, 2);
    assert.match(records[0].patientRef, /^bench-[0-9a-f-]{36}$/);
    assert.notEqual(records[0].patientRef, '100001');
    assert.equal(records[0].payload.date, '2150-01-02');
    assert.equal(records[0].payload.diagnosisCode, 'PRIMARY');
    assert.equal(records[0].payload.summary, 'De-identified demo admission class: URGENT');
    assert.equal(Object.hasOwn(records[0], 'subject_id'), false);
    assert.equal(Object.hasOwn(records[0], 'hadm_id'), false);
    assert.equal(JSON.stringify(records).includes('100001'), false);
    assert.equal(JSON.stringify(records).includes('200001'), false);
    await assert.rejects(loadMimicDemoRecords(root, 101), /from 1 through 100/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('MIMIC benchmark attribution uses its recorded date and emits only aggregate source metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ehr-benchmark-attribution-test-'));
  const hosp = path.join(root, 'mimic-iv-demo-2.2', 'hosp');
  await mkdir(hosp, { recursive: true });
  await writeFile(path.join(hosp, 'patients.csv.gz'), gzipSync('subject_id,gender\n100001,F\n'));
  await writeFile(path.join(hosp, 'admissions.csv.gz'), gzipSync('subject_id,hadm_id,admittime,admission_type\n100001,200001,2150-01-02 12:00:00,URGENT\n'));
  await writeFile(path.join(hosp, 'diagnoses_icd.csv.gz'), gzipSync('hadm_id,seq_num,icd_code\n200001,1,PRIMARY\n'));
  try {
    const result = await runBenchmark({ source: 'mimic-demo', inputDirectory: root, records: 1, recordedAt: '2025-04-03T12:00:00.000Z' });
    assert.equal(result.source.attribution, 'MIMIC-IV Clinical Database Demo, accessed 2025-04-03 from https://registry.opendata.aws/mimic-iv-demo/; documentation DOI 10.13026/dp1f-ex47.');
    assert.equal(result.protocol.records, 1);
    assert.doesNotMatch(JSON.stringify(result), /100001|200001|subject_id|hadm_id|patientRef|recordId/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('synthetic fixtures and bootstrap summaries are bounded, aggregate, and deterministic', () => {
  const fixtures = makeSyntheticRecords(3);
  assert.equal(fixtures.length, 3);
  assert.equal(fixtures[0].payload.recordType, 'lab');
  assert.doesNotMatch(JSON.stringify(summarizeSamples([1, 2, 3, 4, 5])), /patientRef|recordId|subject_id/);
  assert.deepEqual(summarizeSamples([1, 2, 3, 4, 5]), summarizeSamples([1, 2, 3, 4, 5]));
  assert.equal(summarizeSamples([1, 2, 3, 4, 5]).p50, 3);
  assert.equal(summarizeSamples([1, 2, 3, 4, 5]).bootstrap_95pct_ci_for_median.length, 2);
});

test('synthetic benchmark exercises tamper detection, consent, revocation, and emits aggregate-only evidence', async () => {
  const result = await runBenchmark({ source: 'synthetic', records: 2, recordedAt: '2026-09-29T00:00:00.000Z' });
  assert.equal(result.protocol.records, 2);
  assert.equal(result.measurements.local_evm.behavior.consent_grants_succeeded, 2);
  assert.equal(result.measurements.local_evm.behavior.pre_grant_denials, 2);
  assert.equal(result.measurements.local_evm.behavior.integrity_tampering_detected, 2);
  assert.equal(result.measurements.local_evm.behavior.revocations_succeeded, 2);
  assert.equal(result.measurements.local_evm.behavior.post_revocation_denials, 2);
  assert.equal(result.measurements.no_blockchain_baseline.behavior.integrity_tampering_detected, 2);
  assert.equal(result.measurements.local_evm.gas.create.n, 2);
  assert.equal(result.measurements.local_evm.estimated_evm_record_state_bytes_per_record, 160);
  assert.equal(result.environment.node.startsWith('v'), true);
  assert.equal(result.interpretation.clinical_prediction_evaluated, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /synthetic-benchmark-|patientRef|recordId|subject_id|hadm_id|commitmentSalt/);
  assert.equal(result.source.raw_data_included, false);
});
