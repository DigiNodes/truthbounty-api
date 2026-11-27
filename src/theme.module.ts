import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { ThemeController } from './theme.controller';
import { UserThemePreference } from './theme.entity';
import { ThemeService } from './theme.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserThemePreference]),
    AuthModule,
  ],
  controllers: [ThemeController],
  providers: [ThemeService],
  exports: [ThemeService],
})
export class ThemeModule {}
