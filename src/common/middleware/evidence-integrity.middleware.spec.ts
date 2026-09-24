import { EvidenceIntegrityMiddleware } from "./evidence-integrity.middleware";
import * as cidVerifier from "../../storage/cid-verifier";

describe("EvidenceIntegrityMiddleware", () => {
  let middleware: EvidenceIntegrityMiddleware;
  let mockReq: any;
  let mockRes: any;
  let mockNext: jest.Mock;

  beforeEach(() => {
    middleware = new EvidenceIntegrityMiddleware();
    mockNext = jest.fn();
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  it("should call next() when no file is present", async () => {
    mockReq = { body: { cid: "bafybeiabc123" } };
    await middleware.use(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("should call next() when no cid is present", async () => {
    mockReq = { file: { buffer: Buffer.from("data") }, body: {} };
    await middleware.use(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("should call next() when both file and cid are absent", async () => {
    mockReq = { body: {} };
    await middleware.use(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledTimes(1);
  });

  it("should call next() when CID integrity check passes", async () => {
    mockReq = {
      file: { buffer: Buffer.from("valid content") },
      body: { cid: "bafybeiabc123" },
    };
    jest.spyOn(cidVerifier, "verifyCIDIntegrity").mockResolvedValue(true);

    await middleware.use(mockReq, mockRes, mockNext);

    expect(cidVerifier.verifyCIDIntegrity).toHaveBeenCalledWith(
      mockReq.file.buffer,
      mockReq.body.cid,
    );
    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("should return 400 when CID integrity check fails", async () => {
    mockReq = {
      file: { buffer: Buffer.from("tampered content") },
      body: { cid: "bafybeiabc123" },
    };
    jest.spyOn(cidVerifier, "verifyCIDIntegrity").mockResolvedValue(false);

    await middleware.use(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: "Evidence integrity verification failed",
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should return 500 when verifyCIDIntegrity throws an error", async () => {
    mockReq = {
      file: { buffer: Buffer.from("content") },
      body: { cid: "bafybeiabc123" },
    };
    jest
      .spyOn(cidVerifier, "verifyCIDIntegrity")
      .mockRejectedValue(new Error("Unexpected failure"));

    await middleware.use(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: "Evidence integrity verification encountered an error",
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should not call next() after sending a 400 response", async () => {
    mockReq = {
      file: { buffer: Buffer.from("bad") },
      body: { cid: "bafybeiabc123" },
    };
    jest.spyOn(cidVerifier, "verifyCIDIntegrity").mockResolvedValue(false);

    await middleware.use(mockReq, mockRes, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
  });
});
