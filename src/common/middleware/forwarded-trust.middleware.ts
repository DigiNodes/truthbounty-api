import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

const logger = new Logger('ForwardedTrustMiddleware');

// Trusted proxy IPs (e.g., load balancers, reverse proxies)
// In production, this should be configured via environment variables
const TRUSTED_PROXIES = process.env.TRUSTED_PROXIES
  ? process.env.TRUSTED_PROXIES.split(',').map((ip) => ip.trim())
  : [];

// Maximum number of hops allowed
const MAX_HOPS = parseInt(process.env.MAX_PROXY_HOPS || '1', 10);

export class ForwardedTrustMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const xForwardedFor = req.headers['x-forwarded-for'];
    const xForwardedProto = req.headers['x-forwarded-proto'];

    // Validate X-Forwarded-Proto
    if (xForwardedProto) {
      const proto = Array.isArray(xForwardedProto) ? xForwardedProto[0] : xForwardedProto;
      if (proto !== 'https') {
        logger.warn(`Non-HTTPS protocol forwarded: ${proto}`);
        // Fail closed: reject non-HTTPS forwarded requests
        res.status(400).json({ error: 'Invalid protocol' });
        return;
      }
    }

    // Validate X-Forwarded-For
    if (xForwardedFor) {
      const ips = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
      const ipList = ips.split(',').map((ip) => ip.trim());

      // Check if the number of hops exceeds the limit
      if (ipList.length > MAX_HOPS) {
        logger.warn(`Too many proxy hops: ${ipList.length}`);
        res.status(400).json({ error: 'Too many proxy hops' });
        return;
      }

      // Validate that the immediate proxy is trusted
      const immediateProxyIp = ipList[ipList.length - 1];
      if (!TRUSTED_PROXIES.includes(immediateProxyIp)) {
        logger.warn(`Untrusted proxy IP: ${immediateProxyIp}`);
        res.status(403).json({ error: 'Untrusted proxy' });
        return;
      }

      // Set the client IP to the first IP in the chain (original client)
      req.ip = ipList[0];
      req.ips = ipList.slice(0, -1); // Exclude the immediate proxy
    }

    next();
  }
}