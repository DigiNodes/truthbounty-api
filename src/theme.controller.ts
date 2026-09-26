import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ThemeService, Theme, ThemePreference } from './theme.service';

@ApiTags('Theme')
@Controller('theme')
export class ThemeController {
  constructor(private readonly themeService: ThemeService) {}

  @Get()
  @ApiOperation({
    summary: 'Get current theme preference',
    description: 'Returns the current theme preference for a user or anonymous session'
  })
  @ApiQuery({
    name: 'userId',
    required: false,
    description: 'User ID for authenticated users'
  })
  @ApiResponse({
    status: 200,
    description: 'Current theme preference',
    schema: {
      type: 'object',
      properties: {
        theme: {
          type: 'string',
          enum: ['light', 'dark', 'system'],
          example: 'dark'
        },
        userId: {
          type: 'string',
          example: 'user-123'
        },
        updatedAt: {
          type: 'string',
          format: 'date-time'
        }
      }
    }
  })
  getTheme(@Query('userId') userId?: string): { theme: Theme; resolved: 'light' | 'dark' } {
    const theme = this.themeService.getTheme(userId);
    const resolved = this.themeService.getResolvedTheme(userId);

    return { theme, resolved };
  }

  @Post()
  @ApiOperation({
    summary: 'Set theme preference',
    description: 'Sets the theme preference for a user or anonymous session'
  })
  @ApiResponse({
    status: 200,
    description: 'Theme preference updated successfully',
    type: Object
  })
  setTheme(
    @Body() body: { theme: Theme; userId?: string }
  ): ThemePreference {
    return this.themeService.setTheme(body.theme, body.userId);
  }

  @Post('toggle')
  @ApiOperation({
    summary: 'Toggle between light and dark themes',
    description: 'Toggles between light and dark themes, ignoring system preference'
  })
  @ApiResponse({
    status: 200,
    description: 'Theme toggled successfully',
    type: Object
  })
  toggleTheme(
    @Body() body: { userId?: string }
  ): ThemePreference {
    return this.themeService.toggleTheme(body.userId);
  }

  @Post('reset')
  @ApiOperation({
    summary: 'Reset to system preference',
    description: 'Resets theme to follow system preference'
  })
  @ApiResponse({
    status: 200,
    description: 'Theme reset to system preference',
    type: Object
  })
  resetToSystem(
    @Body() body: { userId?: string }
  ): ThemePreference {
    return this.themeService.resetToSystem(body.userId);
  }

  @Get('resolved')
  @ApiOperation({
    summary: 'Get resolved theme',
    description: 'Returns the actual theme (light/dark) after resolving system preference'
  })
  @ApiQuery({
    name: 'userId',
    required: false,
    description: 'User ID for authenticated users'
  })
  @ApiResponse({
    status: 200,
    description: 'Resolved theme (light or dark)',
    schema: {
      type: 'object',
      properties: {
        theme: {
          type: 'string',
          enum: ['light', 'dark'],
          example: 'dark'
        }
      }
    }
  })
  getResolvedTheme(@Query('userId') userId?: string): { theme: 'light' | 'dark' } {
    const theme = this.themeService.getResolvedTheme(userId);
    return { theme };
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get theme usage statistics',
    description: 'Returns statistics on theme preferences (admin endpoint)'
  })
  @ApiResponse({
    status: 200,
    description: 'Theme usage statistics',
    schema: {
      type: 'object',
      properties: {
        light: { type: 'number', example: 150 },
        dark: { type: 'number', example: 200 },
        system: { type: 'number', example: 50 }
      }
    }
  })
  getThemeStats(): { light: number; dark: number; system: number } {
    return this.themeService.getThemeStats();
  }
}