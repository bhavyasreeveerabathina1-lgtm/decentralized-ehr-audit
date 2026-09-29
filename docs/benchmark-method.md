# Reproducible Benchmark: EHR Authenticity and Consent Audit

## Research question

On a single local machine, what integrity, consent, latency, throughput, and storage-cost behavior does this educational audit prototype show on de-identified MIMIC-IV Clinical Database Demo records, compared with the same application flow backed by an in-process metadata map instead of a blockchain?

This is a software-systems and security-mechanism evaluation. It does **not** test diagnosis, treatment, clinical correctness, prediction, or patient outcomes. A recorded commitment only supports consistency checking against the committed bytes; it does not establish that a clinical value is true.

## Data, license, and attribution

The optional real-data input is the public **MIMIC-IV Clinical Database Demo, release 2.2**, a de-identified subset containing 100 patients from Beth Israel Deaconess Medical Center and excluding free-text clinical notes. PhysioNet states that anyone may access the demo files subject to the dataset license; its [release page](https://physionet.org/content/mimic-iv-demo/2.2/) exposes both file downloads and a ZIP. The [AWS Open Data registry](https://registry.opendata.aws/mimic-iv-demo/) describes the 100-patient subset, says no AWS account is required, and lists the **Open Data Commons Open Database License v1.0 (ODbL-1.0)**. In this run, the 15.4 MB ZIP transfer timed out, so the reproduction command below fetches only the three small public compressed CSV files the benchmark requires.

Required attribution, following the registry's instruction: **MIMIC-IV Clinical Database Demo, accessed [run date] from the [AWS Open Data registry](https://registry.opendata.aws/mimic-iv-demo/).** The aggregate output fills in the actual access date from its run timestamp. Cite the [PhysioNet release page](https://physionet.org/content/mimic-iv-demo/2.2/) and its documentation DOI [10.13026/dp1f-ex47](https://doi.org/10.13026/dp1f-ex47). Check the current license text before reuse. The public demo is distinct from full MIMIC-IV: full MIMIC-IV requires credentialed access, CITI training, and a signed data-use agreement. This project does not download or access the full database.

Only the local benchmark runner reads the demo CSVs. It accepts the publisher's `.csv.gz` files (or uncompressed CSVs), decompresses into memory, joins `patients.csv`, `admissions.csv`, and `diagnoses_icd.csv` transiently, takes the first admission encountered for each subject in file order, selects the lowest-sequence diagnosis for that admission, and maps the date, admission class, and diagnosis code into the prototype's constrained payload. A fresh random demo alias is generated for each row; source IDs are not copied into payloads, logs, output summaries, or repository files. The benchmark's generated ciphertext and chain state exist only in temporary local directories/process memory and are removed on exit. Do not point the benchmark at full MIMIC-IV, any other patient dataset, or data you are not independently authorized to use.

## Reproduction

The default benchmark and all automated tests use fabricated fixtures; no external data is needed:

```bash
npm ci
npm test
npm run benchmark -- --source synthetic --records 12
```

To download and use the public demo locally, install `curl`, then run from the repository root:

```bash
(
  set -euo pipefail
  BENCH_TMP="$(mktemp -d)"
  trap 'rm -rf "$BENCH_TMP"' EXIT
  mkdir -p "$BENCH_TMP/data/hosp"
  for FILE in patients.csv.gz admissions.csv.gz diagnoses_icd.csv.gz; do
    curl -fL "https://physionet.org/files/mimic-iv-demo/2.2/hosp/$FILE?download" -o "$BENCH_TMP/data/hosp/$FILE"
  done
  npm run benchmark -- --source mimic-demo --input "$BENCH_TMP/data" --records 100 --output docs/results/mimic-iv-demo-2.2.json
)
```

The benchmark output is constructed from an explicit aggregate-only schema. Review it before publication; never commit downloaded or extracted source files, local encrypted files, record IDs, patient-level digests, or request/response logs. If PhysioNet adds an account or other access requirement, complete that directly under the applicable terms or stop; do not use another person's credentials. Do not seek full MIMIC-IV access without your own approved credentialing and data-use agreement.

## Workflows and controls

For each selected row, the chain-backed path and the no-blockchain comparator run the same Express API routes, payload, AES-256-GCM encryption, temporary file storage, consent checks, hash checks, verification and retrieval flow. Each record is tested for denial before consent, grant, successful integrity verification, authorized retrieval, one ciphertext-tamper rejection, revocation, and denial after revocation.

The local-EVM workflow uses the existing Solidity contract on a fresh Hardhat Network node. The baseline uses the same API and encrypted store but an in-process map for record metadata and expiring consent; it has no contract, signatures, consensus, or network fees. Both workflows run sequentially in one process on the same machine, with the EVM path first. This is a deliberately simple local comparator, not a production database or distributed-system baseline.

The benchmark reports the runtime version/platform/architecture, per-operation latency (`create`, `grant`, `verify`, `access`, both consent denials, tamper rejection, and `revoke`), a serial end-to-end records-per-second rate, encrypted envelope file sizes, EVM transaction gas used, an estimate of Solidity state bytes, and an approximate serialized in-memory baseline metadata size. EVM record-state size is estimated from five 32-byte storage slots: `patient`, `patientId`, `dataHash`, `encryptedBlobHash`, and `exists`; because the boolean follows three full-width hashes, it does not pack with the address. One additional 32-byte mapping slot is needed while a grant is active. These estimates exclude trie/block overhead, event logs, hardware-specific disk allocation, encryption-key storage, network consensus, and any dollar price. Gas is a local EVM execution measure, not a fee quote.

## Statistical reporting and limits

For each latency phase, the summary reports the number of operations, arithmetic mean, median, 95th percentile, and a deterministic 1,000-resample nonparametric bootstrap 95% interval for the median. The interval describes per-operation variability in this one sequential run only; it is not an estimate of performance across machines, deployments, hospitals, or patients. The benchmark uses a single pass, does not randomize or counterbalance workflow order, and does not isolate CPU, filesystem, or compiler warm-up effects. Repeat runs on matched hardware and counterbalanced order are needed for stronger system-level claims.

The demo is small, de-identified, and has no free-text notes. Date shifting and dataset curation limit representativeness. Synthetic fixtures remain the reproducible fallback. Test results and benchmark metrics are evidence only for the tested code, local environment, and workflow; they do not imply clinical safety, regulatory compliance, production readiness, blockchain decentralization, or admission outcomes.
