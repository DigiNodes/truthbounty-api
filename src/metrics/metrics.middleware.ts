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
    metricsService.incrementRequest(
      req.method,
      req.route?.path || req.path,
      res.statusCode.toString(),
    );
    metricsService.observeLatency(
      req.method,
      req.route?.path || req.path,
      res.statusCode.toString(),
      duration,
    );
  });

  next();
}
