// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Educational ledger: only commitments and pseudonymous identifiers belong on-chain.
/// @dev This contract is intentionally small and is not production- or clinical-ready.
contract EHRAudit {
    struct Record {
        address patient;
        bytes32 patientId;
        bytes32 dataHash;
        bytes32 encryptedBlobHash;
        bool exists;
    }

    mapping(bytes32 => Record) private records;
    mapping(bytes32 => mapping(address => uint64)) private accessUntil;

    event RecordCreated(bytes32 indexed recordId, bytes32 indexed patientId, address indexed patient, bytes32 dataHash, bytes32 encryptedBlobHash);
    event AccessGranted(bytes32 indexed recordId, address indexed patient, address indexed grantee, uint64 expiresAt);
    event AccessRevoked(bytes32 indexed recordId, address indexed patient, address indexed grantee);
    event RecordAccessed(bytes32 indexed recordId, address indexed actor, uint64 occurredAt);

    modifier recordExists(bytes32 recordId) {
        require(records[recordId].exists, "unknown record");
        _;
    }

    function createRecord(bytes32 recordId, bytes32 patientId, bytes32 dataHash, bytes32 encryptedBlobHash) external {
        require(recordId != bytes32(0) && patientId != bytes32(0), "empty identifier");
        require(!records[recordId].exists, "record already exists");
        records[recordId] = Record(msg.sender, patientId, dataHash, encryptedBlobHash, true);
        emit RecordCreated(recordId, patientId, msg.sender, dataHash, encryptedBlobHash);
    }

    function grantAccess(bytes32 recordId, address grantee, uint64 expiresAt) external recordExists(recordId) {
        Record storage record = records[recordId];
        require(msg.sender == record.patient, "patient only");
        require(grantee != address(0) && grantee != record.patient, "invalid grantee");
        require(expiresAt > block.timestamp, "expiry must be in future");
        accessUntil[recordId][grantee] = expiresAt;
        emit AccessGranted(recordId, msg.sender, grantee, expiresAt);
    }

    function revokeAccess(bytes32 recordId, address grantee) external recordExists(recordId) {
        require(msg.sender == records[recordId].patient, "patient only");
        accessUntil[recordId][grantee] = 0;
        emit AccessRevoked(recordId, msg.sender, grantee);
    }

    function hasAccess(bytes32 recordId, address actor) public view recordExists(recordId) returns (bool) {
        Record storage record = records[recordId];
        return actor == record.patient || accessUntil[recordId][actor] > block.timestamp;
    }

    /// @notice Emit an immutable audit event after the application has checked consent and integrity.
    function recordAccess(bytes32 recordId) external recordExists(recordId) {
        require(hasAccess(recordId, msg.sender), "access not granted");
        emit RecordAccessed(recordId, msg.sender, uint64(block.timestamp));
    }

    /// @notice Exposes only commitments and the patient wallet; encrypted content stays off-chain.
    function getRecord(bytes32 recordId) external view recordExists(recordId)
        returns (address patient, bytes32 patientId, bytes32 dataHash, bytes32 encryptedBlobHash)
    {
        Record storage record = records[recordId];
        return (record.patient, record.patientId, record.dataHash, record.encryptedBlobHash);
    }

    function accessExpiry(bytes32 recordId, address actor) external view recordExists(recordId) returns (uint64) {
        return accessUntil[recordId][actor];
    }
}
