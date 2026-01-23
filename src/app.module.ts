import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { IndexerModule } from './indexer';
import { IndexerConfigService } from './config';
import { IndexedEvent, IndexingState } from './entities';

@Module({
  imports: [
    // Load environment variables
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Configure TypeORM database connection
    TypeOrmModule.forRootAsync({
      inject: [IndexerConfigService],
      useFactory: (configService: IndexerConfigService) => {
        const dbConfig = configService.getDatabaseConfig();
        return {
          type: 'postgres',
          host: dbConfig.host,
          port: dbConfig.port,
          username: dbConfig.username,
          password: dbConfig.password,
          database: dbConfig.database,
          entities: [IndexedEvent, IndexingState],
          synchronize: dbConfig.synchronize,
          logging: dbConfig.logging,
        };
      },
    }),

    // Register indexer module
    IndexerModule,
  ],
import { BlockchainModule } from './blockchain/blockchain.module';

@Module({
  imports: [BlockchainModule],
  controllers: [AppController],
  providers: [AppService, IndexerConfigService],
})
export class AppModule {}
