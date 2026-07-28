// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./IClaimRegistry.sol";

contract VerificationEngine {
    using SafeERC20 for IERC20;

    enum VerificationVerdict {
        TRUE,
        FALSE
    }

    struct Verification {
        uint256 id;
        uint256 claimId;
        address verifier;
        VerificationVerdict verdict;
        uint256 stake;
        uint64 submittedAt;
    }

    // State Variables
    IClaimRegistry public claimRegistry;
    IERC20 public stakeToken;
    uint256 public minimumStake;
    
    uint256 private _verificationCounter;

    // claimId => verifier => hasVerified
    mapping(uint256 => mapping(address => bool)) public hasVerified;
    
    // claimId => verifier => Verification
    mapping(uint256 => mapping(address => Verification)) private _verifications;
    
    // claimId => verificationIds[]
    mapping(uint256 => uint256[]) private _claimVerificationIds;
    
    // verificationId => Verification
    mapping(uint256 => Verification) private _verificationById;

    // Events
    event VerificationSubmitted(
        uint256 indexed claimId,
        uint256 indexed verificationId,
        address indexed verifier,
        VerificationVerdict verdict,
        uint256 stake
    );

    // Errors
    error ClaimDoesNotExist();
    error ClaimNotUnderVerification();
    error ClaimAlreadyResolved();
    error AlreadyVerified();
    error InsufficientStake();
    error VerifierBanned();

    // Modifiers
    modifier onlyEligibleVerifier() {
        // Future: implement World ID integration or ban lists here
        _;
    }

    constructor(
        address _claimRegistry,
        address _stakeToken,
        uint256 _minimumStake
    ) {
        require(_claimRegistry != address(0), "Invalid registry address");
        require(_stakeToken != address(0), "Invalid token address");
        claimRegistry = IClaimRegistry(_claimRegistry);
        stakeToken = IERC20(_stakeToken);
        minimumStake = _minimumStake;
    }

    function submitVerification(
        uint256 claimId,
        VerificationVerdict verdict,
        uint256 stakeAmount
    ) external onlyEligibleVerifier {
        // 1. Validation
        if (!claimRegistry.claimExists(claimId)) revert ClaimDoesNotExist();
        if (claimRegistry.isClaimResolved(claimId)) revert ClaimAlreadyResolved();
        if (!claimRegistry.isClaimUnderVerification(claimId)) revert ClaimNotUnderVerification();
        if (stakeAmount < minimumStake) revert InsufficientStake();
        if (hasVerified[claimId][msg.sender]) revert AlreadyVerified();

        // 2. Lock Stake
        // Reverts if allowance or balance is insufficient
        stakeToken.safeTransferFrom(msg.sender, address(this), stakeAmount);

        // 3. Store Verification
        _verificationCounter++;
        uint256 verificationId = _verificationCounter;

        Verification memory newVerification = Verification({
            id: verificationId,
            claimId: claimId,
            verifier: msg.sender,
            verdict: verdict,
            stake: stakeAmount,
            submittedAt: uint64(block.timestamp)
        });

        hasVerified[claimId][msg.sender] = true;
        _verifications[claimId][msg.sender] = newVerification;
        _claimVerificationIds[claimId].push(verificationId);
        _verificationById[verificationId] = newVerification;

        // 4. Emit Event
        emit VerificationSubmitted(
            claimId,
            verificationId,
            msg.sender,
            verdict,
            stakeAmount
        );
    }

    // Retrieval Functions
    function getVerification(uint256 verificationId) external view returns (Verification memory) {
        return _verificationById[verificationId];
    }

    function getVerificationByVerifier(uint256 claimId, address verifier) external view returns (Verification memory) {
        return _verifications[claimId][verifier];
    }

    function getClaimVerifications(uint256 claimId) external view returns (Verification[] memory) {
        uint256[] memory ids = _claimVerificationIds[claimId];
        Verification[] memory verifications = new Verification[](ids.length);
        
        for (uint256 i = 0; i < ids.length; i++) {
            verifications[i] = _verificationById[ids[i]];
        }
        
        return verifications;
    }

    function getVerificationCount(uint256 claimId) external view returns (uint256) {
        return _claimVerificationIds[claimId].length;
    }

    function getVerifierStake(uint256 claimId, address verifier) external view returns (uint256) {
        return _verifications[claimId][verifier].stake;
    }
}
