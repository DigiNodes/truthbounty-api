import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { AiExceptionFilter } from './ai-exception.filter';
import { AiMetricsService } from '../../metrics/ai-metrics.service';
import { SafetyGuardrailService } from '../../services/safety-guardrail.service';

describe('AiExceptionFilter', () => {
  let filter: AiExceptionFilter;
  let metrics: jest.Mocked<Pick<AiMetricsService, 'recordRateLimited'>>;
  let statusMock: jest.Mock;
  let jsonMock: jest.Mock;

  const buildHost = (request: any = { id: 'req-1' }) => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    return {
      switchToHttp: () => ({
        getResponse: () => ({ status: statusMock }),
        getRequest: () => request,
      }),
    } as any;
  };

  beforeEach(() => {
    metrics = { recordRateLimited: jest.fn() };
    const safetyGuardrailService = new SafetyGuardrailService({
      get: jest.fn().mockReturnValue({
        maxPromptLength: 4000,
        blockedTerms: [],
        promptLeakHeuristics: [],
      }),
    } as unknown as ConfigService);
    filter = new AiExceptionFilter(
      metrics as unknown as AiMetricsService,
      safetyGuardrailService,
    );
  });

  it('maps a HttpException to its own status code and a derived error code', () => {
    filter.catch(new ForbiddenException('nope'), buildHost());

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        requestId: 'req-1',
        data: null,
        error: { code: 'FORBIDDEN', message: 'nope' },
      }),
    );
  });

  it('maps ThrottlerException to 429 RATE_LIMITED and records the metric', () => {
    filter.catch(
      new ThrottlerException(),
      buildHost({ id: 'req-2', route: { path: '/ai-assistant/x' } }),
    );

    expect(statusMock).toHaveBeenCalledWith(429);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'RATE_LIMITED' }),
      }),
    );
    expect(metrics.recordRateLimited).toHaveBeenCalledWith('ai');
  });

  it('uses the aiStream throttle type when the route path contains "stream"', () => {
    filter.catch(
      new ThrottlerException(),
      buildHost({
        id: 'req-3',
        route: { path: '/ai-assistant/conversations/1/stream/2' },
      }),
    );
    expect(metrics.recordRateLimited).toHaveBeenCalledWith('aiStream');
  });

  it('maps an unrecognized error to a generic 500 without leaking the internal message', () => {
    filter.catch(new Error('db password is hunter2'), buildHost());

    expect(statusMock).toHaveBeenCalledWith(500);
    const [envelope] = jsonMock.mock.calls[0];
    expect(envelope.error.code).toBe('INTERNAL_ERROR');
    expect(envelope.error.message).not.toContain('hunter2');
  });

  it('joins array-shaped validation messages into a single string', () => {
    filter.catch(
      new BadRequestException([
        'content should not be empty',
        'content too long',
      ]),
      buildHost(),
    );

    const [envelope] = jsonMock.mock.calls[0];
    expect(envelope.error.message).toBe(
      'content should not be empty, content too long',
    );
  });
});
