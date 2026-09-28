import { Injectable, NestMiddleware, Inject } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { IdempotencyService } from './idempotency.service';

@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  constructor(
    private readonly idempotencyService: IdempotencyService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    // Only apply to POST, PUT, PATCH, and DELETE requests
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next();
    }

    // Check if idempotency is enabled
    if (!this.idempotencyService.isEnabled()) {
      return next();
    }

    // Get the idempotency key from the header
    const idempotencyKey = req.headers['idempotency-key'] as string;

    // If no key is provided, continue (endpoint should handle this if required)
    if (!idempotencyKey) {
      return next();
    }

    // Validate the key format
    if (!this.idempotencyService.validateKey(idempotencyKey)) {
      return res.status(400).json({
        error: 'Invalid idempotency key',
        message: 'The idempotency key must be a hexadecimal string of at least 32 characters',
      });
    }

    try {
      // Check if we have a stored response for this key
      const storedResponse = await this.idempotencyService.getResponse(idempotencyKey);

      if (storedResponse) {
        // Log the duplicate request
        console.log(`Idempotency hit for key: ${idempotencyKey}`);

        // Return the stored response
        return res.status(storedResponse.status).json(storedResponse.response);
      }

      // If no stored response, we need to capture the response
      const originalSend = res.send;
      const originalJson = res.json;

      // Override res.json to capture the response
      res.json = function(data) {
        // Store the response before sending it
        (async () => {
          try {
            await this.idempotencyService.storeResponse(idempotencyKey, data, res.statusCode);
          } catch (error) {
            console.error('Failed to store idempotency response:', error);
          }
        }).call(this);

        // Call the original json method
        return originalJson.call(this, data);
      }.bind(this);

      // Override res.send to capture the response (in case json isn't used)
      res.send = function(data) {
        // Store the response before sending it
        (async () => {
          try {
            await this.idempotencyService.storeResponse(idempotencyKey, data, res.statusCode);
          } catch (error) {
            console.error('Failed to store idempotency response:', error);
          }
        }).call(this);

        // Call the original send method
        return originalSend.call(this, data);
      }.bind(this);

      // Continue to the next middleware or route handler
      next();
    } catch (error) {
      console.error('Error in idempotency middleware:', error);
      next(error);
    }
  }
}
