# Decentralized EHR Auditing — Cybersecurity Research Prototype

This project studies a narrow system-security question: **on a local machine, what integrity, consent, latency, throughput, and storage behavior does a blockchain-backed EHR audit prototype show compared with the same application flow using an in-process metadata store?** It is an educational research artifact, not a clinical system, medical device, compliance certification, or production-ready EHR. It does not evaluate diagnosis, prediction, or clinical outcomes.

The API and standard walkthrough accept fabricated data only. A separate benchmark can optionally process the public, de-identified [MIMIC-IV Clinical Database Demo, release 2.2](https://physionet.org/content/mimic-iv-demo/2.2/) locally, solely to exercise data-shaped records; it has an explicit opt-in not enabled by the normal server. The demo has 100 patients, excludes free-text notes, and is licensed under the **Open Data Commons Open Database License v1.0 (ODbL-1.0)**. No downloaded dataset or patient-level output belongs in this repository. See the [benchmark protocol and attribution](docs/benchmark-method.md).

## Research and measured evidence

The evaluation pairs the existing local Solidity contract/Hardhat workflow against a no-blockchain control that uses the same Express routes, AES-256-GCM encryption, temporary encrypted file store, consent checks, and integrity checks, but keeps record metadata and grants in an in-process map. For each record it measures consent denial before grant, grant, verification, authorized retrieval, ciphertext-tamper rejection, revocation, and denial after revocation. It reports latency distributions, serial records per second, encrypted file size, local EVM gas, and a documented estimate of storage bytes.

The benchmark prints and can save an aggregate-only JSON summary with deterministic bootstrap intervals for median operation latency. Its intervals describe variation in that one local run, not across machines or hospitals. The committed result at [`docs/results/mimic-iv-demo-2.2.json`](docs/results/mimic-iv-demo-2.2.json) records the actual environment and observations; reproduction details, methods, source/license attribution, and limitations are in [`docs/benchmark-method.md`](docs/benchmark-method.md). Metrics are local educational evidence, not clinical accuracy or production-cost estimates.

On the recorded 100-row run, both backends denied all 100 unauthorized reads, rejected all 100 tamper trials, and enforced all 100 revocations. End-to-end serial throughput was 2.320 records/s with the local EVM and 55.366 records/s with the in-process baseline; median create latency was 56.881 ms (95% bootstrap interval 51.539–60.976 ms) versus 2.771 ms (2.706–2.893 ms). This demonstrates the measured overhead of local contract transactions in this setup, not a general comparison with a production database or decentralized network.

The project is framed as a cybersecurity and systems portfolio artifact because [NYU Tandon's official M.S. in Computer Science page](https://engineering.nyu.edu/academics/programs/computer-science-ms) lists cybersecurity among selectable areas of study. That curricular fit is not an admissions prediction or guarantee; applicants should present their own work and results accurately.

## Run the synthetic demo

Requirements: Node.js 20+ and npm. No external node, wallet, database, or API account is needed for the synthetic demo; the Hardhat Network starts as a local child process.

```bash
npm ci
npm test
npm run compile
export EHR_MASTER_KEY="$(openssl rand -hex 32)"
npm run demo
npm run benchmark -- --source synthetic --records 12
```

The demo starts a fresh, disposable Hardhat chain and a temporary encrypted file store, then removes the stored ciphertext on exit. The API's simulated role header is not authentication; the CLI refuses to bind beyond loopback. `npm start` additionally requires `EHR_MASTER_KEY` (64 hexadecimal characters) and `EHR_ENABLE_DEMO_AUTH=true`; `.env.example` documents settings but is not loaded automatically. Never commit a real `.env`, key material, or data.

## Optional public MIMIC demo benchmark

The MIMIC-IV demo is public and PhysioNet's release page states that anyone may access its files subject to the license; the AWS registry says no AWS account is required. The exact import, run, and temporary cleanup commands are in the [benchmark guide](docs/benchmark-method.md). Full MIMIC-IV is separate and requires credentialed access, CITI training, and a signed data-use agreement; this project does not access it. If the public demo's access terms change, stop and follow the current publisher instructions rather than using anyone else's credentials.

The benchmark uses the demo only on the local machine and deletes temporary encrypted stores on completion. It never emits row-level records, subject/admission identifiers, patient-mapped digests, or keys. It writes only an aggregate-only summary; inspect that JSON before publication and never commit the source ZIP, extracted CSVs, per-record logs, hashes, secrets, or local encrypted files. Following the registry's instruction, cite **MIMIC-IV Clinical Database Demo, accessed 2026-09-29 from the [AWS Open Data registry](https://registry.opendata.aws/mimic-iv-demo/)**; also link the [PhysioNet release](https://physionet.org/content/mimic-iv-demo/2.2/) and [dataset documentation DOI](https://doi.org/10.13026/dp1f-ex47).

## API walkthrough (fabricated data only)

Start the local API in one terminal:

```bash
export EHR_MASTER_KEY="$(openssl rand -hex 32)"
export EHR_ENABLE_DEMO_AUTH=true
npm start
```

The `x-demo-actor: patient|doctor|insurer` header selects a local test signer; it is intentionally impersonable and is not authentication. Create a fabricated record:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/records \
  -H 'content-type: application/json' -H 'x-demo-actor: patient' \
  -d '{"synthetic":true,"patientRef":"patient-demo-001","payload":{"recordType":"lab","date":"2026-09-29","provider":"Example Clinic","diagnosisCode":"LAB-A1","summary":"Synthetic result within reference range."}}'
```

Use the returned record ID for consent, verification, retrieval, revocation, and audit:

```bash
curl -sS -X POST "http://127.0.0.1:3000/api/records/$RECORD_ID/consent" \
  -H 'content-type: application/json' -H 'x-demo-actor: patient' \
  -d '{"grantee":"doctor","expiresInSeconds":3600}'
curl -sS "http://127.0.0.1:3000/api/records/$RECORD_ID/verify" -H 'x-demo-actor: doctor'
curl -sS "http://127.0.0.1:3000/api/records/$RECORD_ID/access" -H 'x-demo-actor: doctor'
curl -sS -X POST "http://127.0.0.1:3000/api/records/$RECORD_ID/revoke/doctor" -H 'x-demo-actor: patient'
curl -sS "http://127.0.0.1:3000/api/records/$RECORD_ID/audit" -H 'x-demo-actor: patient'
```

## Security and privacy boundaries

Record contents remain off-chain, but ledger state and events expose record IDs, wallet addresses, pseudonymous identifiers, consent/access timing, and cryptographic commitments. Pseudonyms are linkable, not anonymous. `AccessReported` is a caller assertion; the contract cannot independently verify that an off-chain blob was fetched or checked. Read the [architecture](docs/architecture.md), [threat model](docs/threat-model.md), and [security notes](docs/security-notes.md) before extension.

This prototype does not authenticate real patients or clinicians, protect plaintext after an authorized recipient copies it, establish medical truth, provide a durable consortium chain, or implement production key management, governance, interoperability, compliance, or incident response. Do not use it for clinical, coverage, reimbursement, or operational decisions.

## Repository map

- `contracts/EHRAudit.sol` — Solidity consent state machine, commitments, and audit events.
- `src/api.js`, `src/crypto.js`, `src/store.js` — API policy, encryption/hash checks, and encrypted local storage.
- `src/system.js` — compile/deploy against a local Hardhat Network node.
- `scripts/demo.js`, `scripts/benchmark.js` — synthetic walkthrough and aggregate-only comparison benchmark.
- `test/` — cryptographic, API, data-import, and benchmark regression tests.
- `docs/` — research method, aggregate result, architecture, report, threat model, and security notes.
