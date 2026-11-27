import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { OptionalJwtAuthGuard } from './auth/optional-jwt-auth.guard';
import { CurrentUser } from './common/decorators/current-user.decorator';
import { Theme, ThemePreference, ThemeService, THEMES } from './theme.service';

export class SetThemeDto {
  @IsIn(THEMES)
  theme: Theme;
}

export class ToggleThemeDto {
  @IsOptional()
  @IsIn(THEMES)
  currentTheme?: Theme;
}

interface ThemePrincipal {
  userId?: string;
  sub?: string;
  user?: { id?: string };
}

@ApiTags('Theme')
@ApiBearerAuth()
@Controller('theme')
export class ThemeController {
  constructor(private readonly themeService: ThemeService) {}

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Get current theme preference',
    description:
      'Authenticated requests read the persisted owner-scoped preference. Unauthenticated requests return the client-scoped default without reading shared server state.',
  })
  @ApiResponse({
    status: 200,
    description: 'Current theme preference',
    schema: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['light', 'dark', 'system'] },
        resolved: { type: 'string', enum: ['light', 'dark'] },
      },
    },
  })
  async getTheme(
    @CurrentUser() principal?: ThemePrincipal,
  ): Promise<{ theme: Theme; resolved: 'light' | 'dark' }> {
    const userId = this.resolveUserId(principal);
    const theme = await this.themeService.getTheme(userId);
    const resolved = await this.themeService.getResolvedTheme(userId);

    return { theme, resolved };
  }

  @Post()
  @ApiOperation({
    summary: 'Set theme preference',
    description:
      'Persists the preference for the authenticated owner. The theme value is restricted to light, dark or system.',
  })
  @ApiResponse({
    status: 200,
    description: 'Theme preference updated successfully',
    type: Object,
  })
  setTheme(
    @CurrentUser() principal: ThemePrincipal,
    @Body() body: SetThemeDto,
  ): Promise<ThemePreference> {
    return this.themeService.setTheme(body.theme, this.resolveUserId(principal));
  }

  @Post('toggle')
  @ApiOperation({
    summary: 'Toggle between light and dark themes',
    description:
      'Toggles the authenticated owner’s persisted preference. currentTheme is only used by client-scoped callers.',
  })
  @ApiResponse({
    status: 200,
    description: 'Theme toggled successfully',
    type: Object,
  })
  toggleTheme(
    @CurrentUser() principal: ThemePrincipal,
    @Body() body: ToggleThemeDto,
  ): Promise<ThemePreference> {
    return this.themeService.toggleTheme(
      this.resolveUserId(principal),
      body?.currentTheme,
    );
  }

  @Post('reset')
  @ApiOperation({
    summary: 'Reset to system preference',
    description: 'Persists the system preference for the authenticated owner.',
  })
  @ApiResponse({
    status: 200,
    description: 'Theme reset to system preference',
    type: Object,
  })
  resetToSystem(
    @CurrentUser() principal: ThemePrincipal,
  ): Promise<ThemePreference> {
    return this.themeService.resetToSystem(this.resolveUserId(principal));
  }

  @Get('resolved')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Get resolved theme',
    description:
      'Returns the actual theme (light/dark) after resolving the system preference.',
  })
  @ApiResponse({
    status: 200,
    description: 'Resolved theme (light or dark)',
    schema: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['light', 'dark'] },
      },
    },
  })
  async getResolvedTheme(
    @CurrentUser() principal?: ThemePrincipal,
  ): Promise<{ theme: 'light' | 'dark' }> {
    const theme = await this.themeService.getResolvedTheme(
      this.resolveUserId(principal),
    );
    return { theme };
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get theme usage statistics',
    description: 'Counts persisted authenticated preferences only.',
  })
  @ApiResponse({
    status: 200,
    description: 'Theme usage statistics',
    schema: {
      type: 'object',
      properties: {
        light: { type: 'number' },
        dark: { type: 'number' },
        system: { type: 'number' },
      },
    },
  })
  getThemeStats(): Promise<{ light: number; dark: number; system: number }> {
    return this.themeService.getThemeStats();
  }

  private resolveUserId(principal?: ThemePrincipal): string | undefined {
    return principal?.userId ?? principal?.user?.id ?? principal?.sub ?? undefined;
  }
}
