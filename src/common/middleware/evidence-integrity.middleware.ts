import { Injectable, NestMiddleware, Logger } from "@nestjs/common";
import { verifyCIDIntegrity } from "../../storage/cid-verifier";

@Injectable()
export class EvidenceIntegrityMiddleware implements NestMiddleware {
  private readonly logger = new Logger(EvidenceIntegrityMiddleware.name);

  async use(req: any, res: any, next: () => void): Promise<void> {
    const file = req.file;
    const cid = req.body?.cid;

    if (!file || !cid) {
      return next();
    }

    try {
      const isValid = await verifyCIDIntegrity(file.buffer, cid);

      if (!isValid) {
        this.logger.warn(`Evidence hash mismatch detected. CID: ${cid}`);
        res.status(400).json({
          message: "Evidence integrity verification failed",
        });
        return;
      }

      next();
    } catch (error) {
      this.logger.error(
        `Evidence integrity check threw an error. CID: ${cid}`,
        error instanceof Error ? error.stack : String(error),
      );
      res.status(500).json({
        message: "Evidence integrity verification encountered an error",
      });
    }
  }
}
