import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';
import { AiBudgetError } from './ai-budget.errors';

/** Keep the public code and retry metadata only for trusted budget exceptions. */
@Catch(AiBudgetError)
export class AiBudgetExceptionFilter implements ExceptionFilter<AiBudgetError> {
  private readonly publicErrors = new GlobalExceptionFilter();

  catch(exception: AiBudgetError, host: ArgumentsHost): void {
    this.publicErrors.catch(exception, host);
  }
}
