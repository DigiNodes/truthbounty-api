import { Request, Response, NextFunction } from 'express';
import { MetricsService } from './metrics.service';

const metricsService = new MetricsService();

export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const start = process.hrtime();

  res.on('finish', () => {
    const diff = process.hrtime(start);
    const duration = diff[0] + diff[1] / 1e9;
    // Only the matched route pattern (`/claims/:id`) is bounded; the raw
    // `req.path` of an unmatched request is attacker-controlled and would let
    // arbitrary URLs/identifiers become label values.
    const route = req.route?.path || 'unmatched';
    metricsService.incrementRequest(
      req.method,
      route,
      res.statusCode.toString(),
    );
    metricsService.observeLatency(
      req.method,
      route,
      res.statusCode.toString(),
      duration,
    );
  });

  next();
}
