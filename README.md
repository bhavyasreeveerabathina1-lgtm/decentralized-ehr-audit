# Decentralized EHR Auditing System — Educational Prototype

This runnable prototype demonstrates a **consent-controlled audit trail** for synthetic healthcare records. It keeps encrypted record contents off-chain, stores salted content commitments and a keyed pseudonymous patient reference in a Solidity contract, and emits ledger events when consent changes or an authorized actor accesses a record.

**It is an educational prototype, not a clinical system, medical device, compliance certification, or production-ready EHR. Use synthetic data only.** Its simulated identities and API headers are intentionally not real authentication.

## What it demonstrates

- Solidity contract deployed to a fresh, local Hardhat Network EVM on application startup.
- Synthetic record JSON encrypted with AES-256-GCM before it is written to a local blob store.
- On-chain commitment to both the encrypted blob and salted plaintext bundle; keyed, deterministic patient pseudonyms reduce simple dictionary guessing, but remain linkable.
- Patient-mediated, expiring doctor/insurer grants and revocation.
- Retrieval checks active consent, verifies the encrypted blob hash, authenticates/decrypts the blob, verifies the plaintext commitment, then emits an access event.
- Integration tests for consent denial, grant, integrity, tampering, revocation, and event history.

The contract stores **no record text**. EVM public state and event metadata remain observable, so pseudonymity is not anonymity. Read [the system design](docs/architecture.md), [threat model](docs/threat-model.md), and [security notes](docs/security-notes.md) before extending it.

## Requirements

- Node.js 20 or later and npm.
- No external node, wallet, database, or API account is needed; Hardhat Network starts automatically as a local child process.

## Install and run

```bash
cd /workspace/decentralized-ehr-audit
npm install
npm test
npm run compile
npm run demo
```

`npm run demo` runs the complete patient → consent → doctor verify/retrieve → patient revoke → audit-trail scenario and exits. `npm start` starts the HTTP API at `http://127.0.0.1:3000` (set `PORT` or `HOST` to override). Startup deploys a fresh contract to a **new in-memory chain**, so ledger state resets when the process exits. By default, encrypted blobs are placed in a temporary directory and removed at shutdown. To preserve ciphertext for inspection, set `EHR_STORE_DIR`; remember that the chain still resets on restart, so persistent blobs will no longer have matching ledger entries.

The default master key is intentionally public and insecure. It is suitable only for disposable, synthetic local demos. If changing it for an experiment, set `EHR_MASTER_KEY` consistently for all components in the same run; changing keys makes existing ciphertext unreadable. `.env.example` documents the available settings; this project does not load `.env` automatically.

## Try the API

Start the server in one terminal:

```bash
npm start
```

The API uses `x-demo-actor: patient|doctor|insurer` to choose one of three local demo signers. This header is **not authentication**; anyone who can reach the demo API can claim any role. Keep the host on loopback and do not expose it to a network.

Create a record using entirely synthetic values:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/records \
  -H 'content-type: application/json' -H 'x-demo-actor: patient' \
  -d '{"synthetic":true,"patientRef":"patient-demo-001","payload":{"recordType":"lab","date":"2026-09-29","provider":"Example Clinic","diagnosisCode":"LAB-A1","summary":"Synthetic result within reference range."}}'
```

Use the returned `recordId` in these examples:

```bash
# Patient grants the doctor access for one hour
curl -sS -X POST http://127.0.0.1:3000/api/records/$RECORD_ID/consent \
  -H 'content-type: application/json' -H 'x-demo-actor: patient' \
  -d '{"grantee":"doctor","expiresInSeconds":3600}'

# Doctor verifies integrity without receiving the record text
curl -sS http://127.0.0.1:3000/api/records/$RECORD_ID/verify -H 'x-demo-actor: doctor'

# Authorized doctor retrieves the synthetic payload
curl -sS http://127.0.0.1:3000/api/records/$RECORD_ID/access -H 'x-demo-actor: doctor'

# Patient revokes access; later doctor reads return 403
curl -sS -X POST http://127.0.0.1:3000/api/records/$RECORD_ID/revoke/doctor -H 'x-demo-actor: patient'

# Inspect on-chain lifecycle and access events
curl -sS http://127.0.0.1:3000/api/records/$RECORD_ID/audit
```

Other endpoints: `GET /health`, `GET /api/demo/accounts`. Payloads accept only the fields shown above, and `synthetic: true` is required. This is a guardrail, **not a way to detect whether supplied values are genuinely synthetic**.

## Repository map

- `contracts/EHRAudit.sol` — Solidity state machine, consent checks, and events.
- `src/api.js` — Express routes and authorization/integrity flow.
- `src/crypto.js`, `src/store.js` — canonical hashes, AES-GCM, and encrypted local storage.
- `src/system.js` — compiler/deployment against a local Hardhat Network node.
- `scripts/demo.js` — complete runnable walkthrough.
- `test/` — unit and integration tests.
- `docs/` — report, architecture, threat model, and security caveats.

## Scope and production boundary

The use case is controlled sharing and independently inspectable audit evidence. A blockchain can make accepted events harder to alter later; it cannot establish that a submitted record is medically correct, prove who was physically using a device, or prevent an authorized recipient from copying plaintext. A real system needs substantial clinical, legal, privacy, identity, infrastructure, and security engineering that this prototype does not implement. See [Security notes](docs/security-notes.md).
