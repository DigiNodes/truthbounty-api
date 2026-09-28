import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

interface CorsConfig {
  origin: string | string[] | ((origin: string | undefined, cb: (err: Error | null, origin?: string | false) => void) => void);
  methods: string;
  allowedHeaders: string;
  exposedHeaders: string;
  credentials: boolean;
  maxAge: number;
}

const logger = new Logger('CorsMiddleware');

export class CorsMiddleware implements NestMiddleware {
  private config: CorsConfig;

  constructor() {
    const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || '';
    const allowedOrigins = allowedOriginsEnv
      ? allowedOriginsEnv.split(',').map((o) => o.trim()).filter(Boolean)
      : [];

    // Default to empty array if no origins specified, effectively blocking all CORS
    const origins = allowedOrigins.length > 0 ? allowedOrigins : [];

    this.config = {
      origin: origins,
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
      allowedHeaders: 'Content-Type,Authorization,X-Request-ID,X-Forwarded-For,X-Forwarded-Proto',
      exposedHeaders: 'X-Request-ID,Retry-After',
      credentials: true,
      maxAge: 600, // 10 minutes
    };
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin;

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      this.handleCors(req, res, origin);
      res.sendStatus(204);
      return;
    }

    // Handle actual requests
    this.handleCors(req, res, origin);
    next();
  }

  private handleCors(req: Request, res: Response, origin: string | undefined): void {
    const allowedOrigins = this.config.origin;

    // If no origins are configured, do not set CORS headers (fail closed)
    if (!allowedOrigins || allowedOrigins.length === 0) {
      return;
    }

    // If origin is not provided, we can't validate it, so we don't set headers
    if (!origin) {
      return;
    }

    // Check if origin is in the allowlist
    if (allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', this.config.methods);
      res.setHeader('Access-Control-Allow-Headers', this.config.allowedHeaders);
      res.setHeader('Access-Control-Expose-Headers', this.config.exposedHeaders);
      res.setHeader('Access-Control-Allow-Credentials', this.config.credentials.toString());
      res.setHeader('Access-Control-Max-Age', this.config.maxAge.toString());
    } else {
      // Origin not allowed: do not set Access-Control-Allow-Origin
      // This ensures the browser blocks the response
      logger.warn(`CORS request rejected for origin: ${origin}`);
    }
  }
}