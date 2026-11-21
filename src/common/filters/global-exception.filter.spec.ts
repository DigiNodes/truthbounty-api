import { AiBudgetError } from '../../ai-assistant/budgets/ai-budget.errors';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';
import { ArgumentsHost } from '@nestjs/common';
import { Response, Request } from 'express';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GlobalExceptionFilter],
    }).compile();

    filter = module.get<GlobalExceptionFilter>(GlobalExceptionFilter);
  });

  it('should be defined', () => {
    expect(filter).toBeDefined();
  });

  describe('catch', () => {
    it('should handle HttpException with correct status and code', () => {
      const mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response;

      const mockRequest = {
        url: '/test',
      } as unknown as Request;

      const mockHost = {
        switchToHttp: () => ({
          getResponse: () => mockResponse,
          getRequest: () => mockRequest,
        }),
      } as unknown as ArgumentsHost;

      const exception = new HttpException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.BAD_REQUEST,
          errorCode: 'BAD_REQUEST',
          message: 'Bad Request',
          path: '/test',
        }),
      );
    });

    it('should handle unknown exceptions with INTERNAL_SERVER_ERROR', () => {
      const mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response;

      const mockRequest = {
        url: '/test',
      } as unknown as Request;

      const mockHost = {
        switchToHttp: () => ({
          getResponse: () => mockResponse,
          getRequest: () => mockRequest,
        }),
      } as unknown as ArgumentsHost;

      const exception = new Error('Something went wrong');

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          errorCode: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected internal error occurred.',
          path: '/test',
        }),
      );
    });

    it('should redact sensitive data in error messages', () => {
      const mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response;

      const mockRequest = {
        url: '/test',
      } as unknown as Request;

      const mockHost = {
        switchToHttp: () => ({
          getResponse: () => mockResponse,
          getRequest: () => mockRequest,
        }),
      } as unknown as ArgumentsHost;

      const exception = new HttpException(
        { message: 'password=secret123' },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const calledWith = (mockResponse.json as unknown as jest.Mock).mock
        .calls[0][0];
      expect(calledWith.message).not.toContain('secret123');
      expect(calledWith.message).toContain('[REDACTED]');
    });

    it('should include requestId and timestamp', () => {
      const mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response;

      const mockRequest = {
        url: '/test',
      } as unknown as Request;

      const mockHost = {
        switchToHttp: () => ({
          getResponse: () => mockResponse,
          getRequest: () => mockRequest,
        }),
      } as unknown as ArgumentsHost;

      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);

      filter.catch(exception, mockHost);

      const calledWith = (mockResponse.json as unknown as jest.Mock).mock
        .calls[0][0];
      expect(calledWith.requestId).toBeDefined();
      expect(calledWith.timestamp).toBeDefined();
    });
  });
});

describe('AI budget public errors', () => {
  const hostFor = (response: any): ArgumentsHost =>
    ({
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ url: '/ai/conversations/thread/messages' }),
      }),
    }) as ArgumentsHost;

  it('keeps the budget code and database reset without exposing scope counters', () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };
    const error = new AiBudgetError(
      'AI_BUDGET_EXHAUSTED',
      new Date('2026-12-01T00:00:00.000Z'),
      new Date('2026-11-30T23:59:00.000Z'),
    );

    new GlobalExceptionFilter().catch(error, hostFor(response));

    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'AI_BUDGET_EXHAUSTED',
        state: 'exhausted',
        resetAt: '2026-12-01T00:00:00.000Z',
        retryAfterSeconds: 60,
      }),
    );
    expect(response.json.mock.calls[0][0]).not.toHaveProperty('remainingTokens');
    expect(response.json.mock.calls[0][0]).not.toHaveProperty('userId');
  });

  it('does not copy budget-looking fields from an unrelated HttpException', () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };
    new GlobalExceptionFilter().catch(
      new HttpException(
        {
          message: 'Too many requests',
          code: 'AI_BUDGET_EXHAUSTED',
          resetAt: '2099-01-01T00:00:00.000Z',
          retryAfterSeconds: 9999999,
          remainingTokens: 123,
        },
        429,
      ),
      hostFor(response),
    );

    expect(response.json.mock.calls[0][0].errorCode).toBe('RATE_LIMITED');
    expect(response.json.mock.calls[0][0]).not.toHaveProperty('resetAt');
    expect(response.json.mock.calls[0][0]).not.toHaveProperty('retryAfterSeconds');
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('distinguishes a request too large for an empty allowance', () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };
    new GlobalExceptionFilter().catch(
      new AiBudgetError('AI_REQUEST_EXCEEDS_BUDGET'),
      hostFor(response),
    );

    expect(response.status).toHaveBeenCalledWith(422);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'AI_REQUEST_EXCEEDS_BUDGET',
        state: 'request_too_large',
        resetAt: null,
        retryAfterSeconds: null,
      }),
    );
    expect(response.setHeader).not.toHaveBeenCalled();
  });
});
