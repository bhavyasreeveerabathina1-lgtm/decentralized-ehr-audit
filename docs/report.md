# Project Report: Decentralized EHR Auditing System

## Problem and objective

Electronic health and insurance records often cross organizational boundaries. Patients need a clear way to authorize and revoke access, while providers and adjusters need confidence that a record has not changed since it was committed. A shared ledger can provide a common, append-only history of commitments and access events without using the ledger as a medical-record database.

This prototype explores that split: **encrypted clinical/claim content remains off-chain; a local EVM ledger records consent state, pseudonymous references, cryptographic commitments, and audit events.** It is designed as a runnable cybersecurity/privacy teaching artifact, not as a deployable healthcare product.

## Requirements addressed

The implementation provides a local test chain, three simulated demo roles (patient, doctor, insurer), a constrained synthetic record schema, AES-256-GCM encryption, tamper checks, time-limited consent, revocation, an audit endpoint, and repeatable tests. The patient may grant access to a doctor or insurer for 60 seconds to 30 days; the patient always retains access, while grantees need an unexpired grant. Successful API verification/retrieval submits an `AccessReported` event, which records a caller assertion and is not independent evidence of an off-chain read.

The prototype also enforces several data-minimization choices: no names, contact details, or record text are submitted on-chain; patient references are keyed before being represented as 32-byte identifiers; and each record's plaintext commitment uses a random salt held inside the encrypted bundle. A verifier receives that salt after authorized verification, allowing recomputation of the commitment when it also has the payload.

## System design

The Node.js API starts a local Hardhat Network node as a child process, compiles and deploys `EHRAudit.sol`, and can select one of three local signers using a demo-only role header. This mode is disabled unless explicitly enabled, and the server refuses non-loopback binding. The patient submits a synthetic record. The API canonicalizes and encrypts the record bundle, writes only the AES-GCM envelope to a local file, and commits the patient pseudonym, salted content hash, and encrypted-envelope hash to the contract. Contract state and events also expose wallet addresses, record IDs, consent/access timing, and other linkable metadata.

When a patient grants consent, the contract stores an expiry for the chosen grantee address and emits `AccessGranted`. An access request checks the on-chain expiry for grantees, checks the stored envelope against its ledger hash, authenticates/decrypts it, checks the salted plaintext commitment, and then submits `AccessReported`. The contract itself cannot verify that a blob was retrieved or checked; direct callers with access can emit the same self-report. Revocation clears the permission and emits `AccessRevoked`. The audit endpoint returns lifecycle events with transaction hashes and block numbers. More detailed components and data flow appear in [the architecture document](architecture.md).

The local chain is deliberately ephemeral: it resets on application restart. By default, the encrypted file store is temporary too. This makes the demo repeatable and avoids leaving synthetic records behind, but does not demonstrate durable storage or recovery.

## Threat model and expected behavior

The prototype considers an unauthorized API caller, an authorized recipient exceeding consent, a modified or substituted ciphertext, disclosure through on-chain metadata, key compromise, and malicious or faulty insiders. Its strongest demo properties are narrow: a grantee without an active grant is denied; a patient or active grantee can retrieve plaintext only after both hash checks; changed ciphertext fails authentication/integrity checks; and revocation blocks later API reads. The event trail records permission changes and caller-reported accesses, not independently verified reads.

These controls do not authenticate real people, constrain a recipient who has already copied plaintext, protect against a compromised host or master key, or establish the clinical validity of submitted data. A hash is evidence of consistency with a prior commitment, not proof of truth. See [the threat model](threat-model.md) for assumptions, mitigations, and residual risks.

## Implementation and verification

The source uses Solidity 0.8.37, Node.js, Express, ethers.js, and Hardhat Network. `npm run demo` executes record creation, denial before consent, grant, verification and retrieval, revocation, post-revocation denial, and audit inspection. `npm test` runs crypto unit tests and API/ledger regressions, including key enforcement, zero commitments, caller-report semantics, failed-write cleanup, expiry, and not-found handling. `npm run compile` writes a local ABI/bytecode artifact under the ignored `artifacts/` directory. Dependency advisories can change over time; run `npm audit` against the current lockfile before use.

Expected audit event sequence includes `RecordCreated`, `AccessGranted`, one or more `AccessReported` caller assertions, and `AccessRevoked`. The contract cannot independently prove that an off-chain record was retrieved or integrity-checked. Test evidence is generated by running the project commands; the README provides exact setup and invocation steps.

## Design choices and trade-offs

A local Hardhat Network EVM chain is used instead of deploying a network or relying on a cloud provider: it keeps the artifact runnable on a laptop and lets students inspect Solidity transactions and logs. Solidity is selected to make authorization logic visible and testable; a permissioned Fabric network would provide a different membership and governance model, but would not remove the need for off-chain encryption and strict key management.

The API acts as a custodial demo adapter: server-held test signers submit transactions, while an explicitly enabled role header selects an actor. The CLI only binds to loopback, but the header remains impersonable and is not a patient-controlled wallet flow. The encrypted file store has no replication, access isolation, lifecycle policy, or durable key service. These choices make the trust boundaries easy to demonstrate while keeping the implementation intentionally small.

## Conclusion

The prototype demonstrates a useful architectural principle: use a ledger for shared integrity commitments and audit evidence, and keep sensitive record contents encrypted and off-chain. It also makes visible the main limitation: blockchain immutability cannot substitute for identity assurance, privacy engineering, secure operations, governance, clinical validation, or legal review. A responsible next iteration would first replace demo identity/key custody and temporary storage, then evaluate a permissioned network and independent security review using synthetic data only.

**Safety boundary:** This repository is educational. Do not use real patient/insurance data or deploy it for clinical, billing, claims, or other operational decisions.
