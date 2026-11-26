import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post,
  UseFilters, UseGuards, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AuthenticatedPrincipal } from '../../auth/types/authenticated-request';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleByWallet } from '../../common/decorators/throttle-by-wallet.decorator';
import { AiBudgetAdminService } from './ai-budget-admin.service';
import { AiBudgetExceptionFilter } from './ai-budget-exception.filter';
import {
  AiBudgetChangeReferenceDto, AiBudgetOverrideDto, AiBudgetPolicyDto, AiBudgetPriceDto,
} from './ai-budget.dto';
import {
  AiBudgetOperatorGuard, getAiBudgetActor, getAiBudgetUserId,
} from './ai-budget-operator.guard';
import { AiBudgetService } from './ai-budget.service';

@ApiTags('ai')
@ApiBearerAuth('JWT-auth')
@Controller('ai/budgets')
@UseGuards(JwtAuthGuard)
@UseFilters(AiBudgetExceptionFilter)
@ThrottleByWallet('ai')
@UsePipes(new ValidationPipe({
  transform: true, whitelist: true, forbidNonWhitelisted: true,
  forbidUnknownValues: true, disableErrorMessages: true,
}))
export class AiBudgetController {
  constructor(
    private readonly budget: AiBudgetService,
    private readonly admin: AiBudgetAdminService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: "Read the current user's charged and unresolved usage" })
  async me(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.budget.getUserUsage(getAiBudgetUserId(principal));
  }

  @Post('admin/prices')
  @UseGuards(RolesGuard, AiBudgetOperatorGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Create an immutable server-supported price version' })
  async createPrice(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() input: AiBudgetPriceDto,
  ) {
    return this.admin.createPrice(getAiBudgetActor(principal), input);
  }

  @Post('admin/policies')
  @UseGuards(RolesGuard, AiBudgetOperatorGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Activate an immutable budget policy version' })
  async activatePolicy(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() input: AiBudgetPolicyDto,
  ) {
    return this.admin.activatePolicy(getAiBudgetActor(principal), input);
  }

  @Post('admin/coverage')
  @UseGuards(RolesGuard, AiBudgetOperatorGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Begin budget coverage at locked database time after legacy traffic quiescence' })
  async beginCoverage(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() input: AiBudgetChangeReferenceDto,
  ) {
    return this.admin.beginCoverage(getAiBudgetActor(principal), input);
  }

  @Post('admin/overrides')
  @UseGuards(RolesGuard, AiBudgetOperatorGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Create a bounded, expiring bonus for a user budget window' })
  async createOverride(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() input: AiBudgetOverrideDto,
  ) {
    return this.admin.createOverride(getAiBudgetActor(principal), input);
  }

  @Post('admin/overrides/:id/revoke')
  @UseGuards(RolesGuard, AiBudgetOperatorGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Revoke a user budget bonus for future admissions' })
  async revokeOverride(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AiBudgetChangeReferenceDto,
  ) {
    return this.admin.revokeOverride(getAiBudgetActor(principal), id, input);
  }
}
