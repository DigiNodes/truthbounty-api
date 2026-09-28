import { WeightedVoteResolutionService } from "../../src/blockchain/weighted-vote-resolution.service";

const service = new WeightedVoteResolutionService();

const vote = (
  userId: string,
  verdict: "TRUE" | "FALSE" | "UNSURE",
  reputation: number,
  stake = "0"
) => ({
  claimId: "claim-1",
  userId,
  verdict,
  userReputation: reputation,
  stakeAmount: stake,
  timestamp: new Date('2024-01-01T00:00:00Z'),
  eventId: `evt-${userId}`
});

describe("Reputation & Vote Weight Calculations", () => {

  it("calculates weight using reputation + sqrt(stake)", () => {
    const votes = [vote("u1", "TRUE", 50, "100")];

    const result = service.resolveClaim(votes, { minTotalWeight: 1 });

    const expectedWeight = 50 + Math.sqrt(100) * 0.1;

    expect(result.totalWeight).toBeCloseTo(expectedWeight, 5);
  });

  it("clamps reputation between 1 and 100", () => {
    const votes = [
      vote("low", "TRUE", -10),
      vote("high", "TRUE", 999),
    ];

    const result = service.resolveClaim(votes, { minTotalWeight: 1 });

    expect(result.totalWeight).toBeGreaterThanOrEqual(2);
    expect(result.totalWeight).toBeLessThanOrEqual(200);
  });

  it("is deterministic for identical inputs", () => {
    const votes = [
      vote("u1", "TRUE", 60),
      vote("u2", "FALSE", 20),
    ];

    const r1 = service.resolveClaim(votes, { minTotalWeight: 1 });
    const r2 = service.resolveClaim(votes, { minTotalWeight: 1 });

    expect(r1).toEqual(r2);
  });

  it("resolves clear majority correctly", () => {
    const votes = [
      vote("u1", "TRUE", 80),
      vote("u2", "TRUE", 70),
      vote("u3", "FALSE", 10),
    ];

    const result = service.resolveClaim(votes, { minTotalWeight: 1 });

    expect(result.resolvedVerdict).toBe("TRUE");
  });

  it("detects ties and returns UNRESOLVED", () => {
    const votes = [
      vote("u1", "TRUE", 50),
      vote("u2", "FALSE", 50),
    ];

    const result = service.resolveClaim(votes, { minTotalWeight: 1 });

    expect(result.resolvedVerdict).toBe("UNRESOLVED");
  });

  it("flags low confidence disputes", () => {
    const votes = [
      vote("u1", "TRUE", 55),
      vote("u2", "FALSE", 45),
    ];

    const result = service.resolveClaim(votes, { minTotalWeight: 1 });

    expect(result.resolvedVerdict).toBe("UNRESOLVED");
  });

  it("rejects whale dominance (fraud prevention)", () => {
    const votes = [
      vote("whale", "TRUE", 100),
      vote("small1", "FALSE", 1),
      vote("small2", "FALSE", 1),
    ];

    const result = service.resolveClaim(votes, {
      minTotalWeight: 1,
      maxReputationShare: 0.4
    });

    expect(result.resolvedVerdict).toBe("UNRESOLVED");
  });

  it("mitigates Sybil attempts (many low-rep voters)", () => {
    const sybilVotes = Array.from({ length: 20 }, (_, i) =>
      vote(`sybil${i}`, "FALSE", 1)
    );

    const honest = [vote("honest", "TRUE", 90)];

    const result = service.resolveClaim(
      [...sybilVotes, ...honest],
      { minTotalWeight: 1 }
    );

    expect(result.resolvedVerdict).toBe("TRUE");
  });

  it("returns unresolved when total weight is insufficient", () => {
    const votes = [vote("u1", "TRUE", 1)];

    const result = service.resolveClaim(votes);

    expect(result.resolvedVerdict).toBe("UNRESOLVED");
  });

});
