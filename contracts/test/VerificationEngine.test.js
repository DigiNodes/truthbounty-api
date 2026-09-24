const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("VerificationEngine", function () {
  let verificationEngine;
  let mockToken;
  let mockRegistry;
  let owner;
  let verifier1;
  let verifier2;
  
  let MINIMUM_STAKE;

  beforeEach(async function () {
    [owner, verifier1, verifier2] = await ethers.getSigners();
    MINIMUM_STAKE = ethers.parseUnits("10", 18);

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy("Mock Token", "MTK");
    
    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    mockRegistry = await MockRegistry.deploy();

    const VerificationEngine = await ethers.getContractFactory("VerificationEngine");
    verificationEngine = await VerificationEngine.deploy(
      await mockRegistry.getAddress(),
      await mockToken.getAddress(),
      MINIMUM_STAKE
    );

    await mockToken.mint(verifier1.address, ethers.parseUnits("1000", 18));
    await mockToken.connect(verifier1).approve(await verificationEngine.getAddress(), ethers.MaxUint256);

    await mockToken.mint(verifier2.address, ethers.parseUnits("1000", 18));
    await mockToken.connect(verifier2).approve(await verificationEngine.getAddress(), ethers.MaxUint256);
  });

  describe("Verification Submission", function () {
    it("Should allow valid TRUE verification submission", async function () {
      await mockRegistry.setClaimStatus(1, true, false, true);

      const tx = await verificationEngine.connect(verifier1).submitVerification(1, 0, MINIMUM_STAKE); 
      await tx.wait();
      
      expect(await mockToken.balanceOf(await verificationEngine.getAddress())).to.equal(MINIMUM_STAKE);

      const hasVerified = await verificationEngine.hasVerified(1, verifier1.address);
      expect(hasVerified).to.be.true;

      const verification = await verificationEngine.getVerificationByVerifier(1, verifier1.address);
      expect(verification.verdict).to.equal(0n);
      expect(verification.stake).to.equal(MINIMUM_STAKE);
      expect(verification.verifier).to.equal(verifier1.address);
    });

    it("Should allow valid FALSE verification submission", async function () {
      await mockRegistry.setClaimStatus(2, true, false, true);
      
      await verificationEngine.connect(verifier1).submitVerification(2, 1, MINIMUM_STAKE);
      
      const verification = await verificationEngine.getVerificationByVerifier(2, verifier1.address);
      expect(verification.verdict).to.equal(1n);
    });

    it("Should revert if claim does not exist", async function () {
      await mockRegistry.setClaimStatus(1, false, false, false);
      
      await expect(
        verificationEngine.connect(verifier1).submitVerification(1, 0, MINIMUM_STAKE)
      ).to.be.revertedWithCustomError(verificationEngine, "ClaimDoesNotExist");
    });

    it("Should revert if claim is not under verification", async function () {
      await mockRegistry.setClaimStatus(1, true, false, false);
      
      await expect(
        verificationEngine.connect(verifier1).submitVerification(1, 0, MINIMUM_STAKE)
      ).to.be.revertedWithCustomError(verificationEngine, "ClaimNotUnderVerification");
    });

    it("Should revert if claim is already resolved", async function () {
      await mockRegistry.setClaimStatus(1, true, true, false);
      
      await expect(
        verificationEngine.connect(verifier1).submitVerification(1, 0, MINIMUM_STAKE)
      ).to.be.revertedWithCustomError(verificationEngine, "ClaimAlreadyResolved");
    });

    it("Should revert if stake is insufficient", async function () {
      await mockRegistry.setClaimStatus(1, true, false, true);
      
      const insufficientStake = ethers.parseUnits("5", 18);
      await expect(
        verificationEngine.connect(verifier1).submitVerification(1, 0, insufficientStake)
      ).to.be.revertedWithCustomError(verificationEngine, "InsufficientStake");
    });

    it("Should revert on duplicate verification", async function () {
      await mockRegistry.setClaimStatus(1, true, false, true);
      
      await verificationEngine.connect(verifier1).submitVerification(1, 0, MINIMUM_STAKE);
      
      await expect(
        verificationEngine.connect(verifier1).submitVerification(1, 1, MINIMUM_STAKE)
      ).to.be.revertedWithCustomError(verificationEngine, "AlreadyVerified");
    });

    it("Should correctly emit VerificationSubmitted event", async function () {
      await mockRegistry.setClaimStatus(1, true, false, true);
      
      await expect(verificationEngine.connect(verifier1).submitVerification(1, 0, MINIMUM_STAKE))
        .to.emit(verificationEngine, "VerificationSubmitted")
        .withArgs(1, 1, verifier1.address, 0, MINIMUM_STAKE);
    });
  });

  describe("Retrieval and Storage", function () {
    it("Should support retrieving all claim verifications", async function () {
      await mockRegistry.setClaimStatus(1, true, false, true);
      
      await verificationEngine.connect(verifier1).submitVerification(1, 0, MINIMUM_STAKE);
      await verificationEngine.connect(verifier2).submitVerification(1, 1, MINIMUM_STAKE);
      
      const count = await verificationEngine.getVerificationCount(1);
      expect(count).to.equal(2n);
      
      const verifications = await verificationEngine.getClaimVerifications(1);
      expect(verifications.length).to.equal(2);
      expect(verifications[0].verifier).to.equal(verifier1.address);
      expect(verifications[1].verifier).to.equal(verifier2.address);
    });
  });

  describe("Gas Benchmarks", function () {
    it("Should benchmark first verification submission", async function () {
      await mockRegistry.setClaimStatus(1, true, false, true);
      const tx = await verificationEngine.connect(verifier1).submitVerification(1, 0, MINIMUM_STAKE);
      const receipt = await tx.wait();
      console.log(`Gas used for first verification: ${receipt.gasUsed.toString()}`);
    });

    it("Should benchmark subsequent verification submission", async function () {
      await mockRegistry.setClaimStatus(1, true, false, true);
      await verificationEngine.connect(verifier1).submitVerification(1, 0, MINIMUM_STAKE);
      
      const tx = await verificationEngine.connect(verifier2).submitVerification(1, 1, MINIMUM_STAKE);
      const receipt = await tx.wait();
      console.log(`Gas used for subsequent verification: ${receipt.gasUsed.toString()}`);
    });
  });
});
