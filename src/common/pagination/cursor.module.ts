import { Module, DynamicModule } from '@nestjs/common';
import {
  CursorService,
  CURSOR_CONFIG_TOKEN,
  CursorServiceOptions,
} from './cursor.service';

@Module({})
export class CursorModule {
  static forRoot(options?: CursorServiceOptions): DynamicModule {
    return {
      module: CursorModule,
      global: true,
      providers: [
        CursorService,
        {
          provide: CURSOR_CONFIG_TOKEN,
          useValue: options ?? {},
        },
      ],
      exports: [CursorService],
    };
  }
}
