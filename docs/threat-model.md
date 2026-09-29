# Threat Model

## Scope and security objectives

The demo aims to teach four properties: record content is not written directly to the ledger; a stored encrypted blob can be checked against a ledger commitment; a recipient without an active patient grant is denied by the API; and accepted grants, revocations, and accesses create inspectable EVM events. The system assumes all values are synthetic and runs on one local computer.

## Assets and trust boundaries

Assets include record plaintext before and after decryption, the AES key and pseudonym key (purpose-separated from one master secret), ciphertext files, patient/grantee addresses, consent expiries, hashes, and event history. The trust boundary lies between the caller, the Node API, the filesystem, the local EVM, and the process environment. The API process controls test signers and encryption; the patient/doctor/insurer labels are not authenticated identities.

## Threats and controls

| Threat | Prototype control | Residual risk |
|---|---|---|
| Unauthorized demo role reads a record before consent | API checks the contract's active access mapping before decrypting/returning | Caller can claim any role using `x-demo-actor`; API is not exposed safely to untrusted users |
| Consent remains open indefinitely | Grants have an explicit expiry capped at 30 days; patient can revoke | A leaked key/address or backend compromise can impersonate identities; expiration cannot revoke plaintext already copied |
| Ciphertext is altered | AES-GCM rejects modified ciphertext/authentication tags; envelope hash is compared with the ledger | A compromised host/master key can read or replace local records; no independent storage integrity service exists |
| Plaintext is substituted while retaining a blob | Salted canonical-bundle hash must match the ledger commitment after decryption | API controls verification and key; independent recipients need a trusted verifier/client and the salt/payload |
| Observer guesses patient alias from public hash | A keyed HMAC produces the on-chain pseudonym | Identifier is stable/linkable; key compromise enables mapping; timing, addresses, and access patterns still leak |
| Ledger exposes medical data | Only IDs, addresses, hashes, expiries, and events are recorded | Hashes and metadata may still leak facts or enable correlation; immutable events cannot be erased |
| Malicious insurer/clinician keeps a copy | Nothing | Access control cannot enforce behavior after plaintext disclosure |
| False, poisoned, or clinically wrong input | None; schema requires `synthetic: true` as a teaching guardrail | Ledger proves a commitment was recorded, not that data is true or medically valid |
| Network/economic/consensus attack | Not modeled; local single-node chain | No decentralization, consortium governance, fault tolerance, finality, or realistic adversarial network |
| API abuse or denial of service | JSON body limit and narrow routes | No robust rate limits, monitoring, TLS, WAF, audit alerting, backups, or incident response |

## Assumptions

- Test signers, the master secret, Node process, dependencies, and local machine are trusted for the duration of a demo.
- Role headers are chosen by a trusted demonstrator, not by an internet client.
- The record sample values are fabricated. The `synthetic: true` flag does not validate provenance.
- The embedded chain's state is intentionally disposable and does not model a permissioned production network.

## Out of scope

Real patient authentication, consent policy enforcement by institutions, clinician credentialing, legal basis, key recovery/rotation, data retention/deletion, multi-tenant isolation, reliable off-chain availability, data formats such as FHIR, standards-based audit integration, compliance, clinical workflow, and independent security review are not implemented. See [Security notes](security-notes.md) before any extension.
