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

      const exception = new HttpException('Bad Request', HttpStatus.BAD_REQUEST);

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

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
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

      const exception = new HttpException({ message: 'password=secret123' }, HttpStatus.BAD_REQUEST);

      filter.catch(exception, mockHost);

      const calledWith = mockResponse.json.mock.calls[0][0];
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

      const calledWith = mockResponse.json.mock.calls[0][0];
      expect(calledWith.requestId).toBeDefined();
      expect(calledWith.timestamp).toBeDefined();
    });
  });
});