import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "../src/app.module";

/**
 * Regression tests to ensure compliance with V2 architecture requirements:
 * - Only smart contracts can make authoritative claim/dispute outcomes
 * - No backend endpoints exist that allow API credentials to decide/rewrite claim outcomes
 * - All state is projected from on-chain events, not calculated by the backend
 */
describe("V2 Architecture Compliance (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Legacy dispute resolution endpoints (should be disabled)", () => {
    it("POST /disputes/resolve should return 404 (dispute module disabled)", async () => {
      await request(app.getHttpServer())
        .post("/disputes/resolve")
        .send({
          disputeId: "test-id",
          outcome: true,
          finalConfidence: 0.95,
          metadata: {},
        })
        .expect(404);
    });

    it("POST /disputes/reject should return 404 (dispute module disabled)", async () => {
      await request(app.getHttpServer())
        .post("/disputes/reject")
        .send({
          disputeId: "test-id",
          reason: "test rejection",
        })
        .expect(404);
    });
  });

  describe("Blockchain claim resolution endpoints (should be disabled)", () => {
    it("POST /api/v1/blockchain/votes/resolve should return 404 (weighted voting disabled)", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/blockchain/votes/resolve")
        .send({
          votes: [],
          config: {},
        })
        .expect(404);
    });

    it("POST /api/v1/blockchain/votes/validate should return 404 (weighted voting disabled)", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/blockchain/votes/validate")
        .send({
          votes: [],
        })
        .expect(404);
    });
  });

  describe("Claim resolution services (should not be available to API)", () => {
    it("No backend services can set claim outcomes authoritatively - all state comes from on-chain events", () => {
      // This test verifies that the ClaimResolutionService and WeightedVoteResolutionService
      // are no longer registered in the application context, ensuring they cannot be used
      // to make authoritative decisions
      
      // Verify that the necessary modules are loaded but the backend-authoritative services are not
      const claimsModule = app.get<unknown>('ClaimsModule');
      expect(claimsModule).toBeDefined();
      
      const blockchainModule = app.get<unknown>('BlockchainModule');
      expect(blockchainModule).toBeDefined();
      
      // These services should not be injectable anymore as they were removed from their modules
      expect(() => app.get('ClaimResolutionService')).toThrow();
      expect(() => app.get('WeightedVoteResolutionService')).toThrow();
    });
  });
});