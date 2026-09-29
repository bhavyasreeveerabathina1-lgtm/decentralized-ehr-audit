# Security, Privacy, and Production Boundaries

**Do not use this project with PHI, identifiable patient or insurance data, or any operational record. Do not use it to make clinical, coverage, reimbursement, or operational decisions.** It is a small, local educational prototype and is not a compliance assessment.

The regular demo API accepts fabricated data only. The optional benchmark has a separate, explicit opt-in for the openly published, de-identified 100-patient [MIMIC-IV Clinical Database Demo](https://physionet.org/content/mimic-iv-demo/2.2/) under its ODbL-1.0 terms. That exception exists only for a local reproducible measurement: source rows and generated ciphertext remain in temporary local processing/storage and are removed at exit; only aggregate metrics may be saved. It is not permission to use other datasets, full MIMIC-IV, or data you are not authorized to access. See [the benchmark protocol](benchmark-method.md) for source, attribution, and cleanup details.

## Identity and access control are simulated

When explicitly enabled with `EHR_ENABLE_DEMO_AUTH=true`, the API accepts `x-demo-actor: patient|doctor|insurer` and chooses a local Hardhat test signer. The role routes are disabled by default, and the CLI refuses non-loopback binding; these are local-demo guardrails, not authentication. Anyone who can reach the enabled API can still choose any role. The patient does not hold or sign with an independent wallet; the backend is a custodian for every demo identity. The contract itself can be called directly by arbitrary local-chain accounts, so the app's role restrictions are not a network identity system.

A real design would need strong identity proofing, institutional membership, authentication, patient-controlled transaction signing or a rigorously governed custody model, account recovery, least privilege, separation of duties, phishing defenses, and a security-tested authorization service.

## Encryption and key handling

The demo uses AES-256-GCM with a random 96-bit IV per record and a 128-bit authentication tag. It derives different encryption and patient-pseudonym keys from `EHR_MASTER_KEY` using purpose labels. A 32-byte random key encoded as exactly 64 hexadecimal characters is required; there is no source-defined fallback, and startup fails if it is missing or malformed. This requirement does not provide full key management: there is no HSM/KMS, rotation, backup, tenant separation, envelope-key wrapping, access-controlled key service, or emergency recovery. Losing/changing the secret makes stored data unreadable; leaking it exposes every record encrypted under it.

Hashes provide tamper evidence only relative to the committed version. The salted plaintext commitment uses a random 32-byte value stored inside the encrypted bundle; an authorized response reveals it so a client with the matching record can recompute the commitment. The keyed patient pseudonym reduces offline guessing of a low-entropy alias by someone who sees only the chain, but is deterministic and correlatable. It does not anonymize a person. Contract hashes, addresses, and event timing also carry metadata risk.

The contract emits `AccessReported` only as a caller assertion after checking on-chain ownership/consent. It cannot inspect the off-chain blob. The API verifies the envelope and plaintext commitments before it submits its own event, but a direct caller with access can submit the same event without those checks; do not interpret the event as independent proof of a verified read. The audit API exposes linkable contract events and scans the local chain's history; it is a teaching endpoint, not a rate-limited public service.

## Consent and revocation limits

Revocation prevents future API access through this process after the contract state changes. It cannot erase a recipient's downloaded plaintext, screenshots, exports, local caches, backups, or memory. Contract events are append-only and cannot be deleted. Consent scope is only a record/grantee/expiry tuple; there is no purpose limitation, emergency break-glass procedure, policy engine, legal representation, or audit review workflow.

## Ledger and storage limits

Hardhat Network runs in memory, with one local operator and no independently governed validators. The ledger is neither Byzantine-fault tolerant nor a realistic private consortium chain. The file store is a convenience layer, not hardened storage: no replication, filesystem ACL model beyond restrictive local mode bits, backup, data lifecycle enforcement, access isolation, or durable recovery is provided. A durable chain with encrypted blobs would require careful operational controls and a privacy/legal review; simply switching to a public chain would increase disclosure risk.

## Privacy engineering required before real deployment

A production effort would need a formal data-flow and re-identification review; appropriate legal authority and consent design; data minimization and retention rules; realistic threat modeling; verified identity and organizational governance; a key lifecycle and recovery design; secure client-to-server channels and storage; incident response; independent contract/API audits; accessibility and clinical safety validation; interoperability requirements; and jurisdiction-specific legal, privacy, and security review. A permissioned blockchain can limit who participates but does not make stored data confidential or correct.
