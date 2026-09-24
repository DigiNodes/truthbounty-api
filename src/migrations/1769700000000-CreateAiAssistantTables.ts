import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAiAssistantTables1769700000000 implements MigrationInterface {
  name = 'CreateAiAssistantTables1769700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "conversations" (
        "id" varchar PRIMARY KEY NOT NULL,
        "userId" varchar NOT NULL,
        "title" varchar,
        "mode" varchar NOT NULL DEFAULT ('general'),
        "status" varchar NOT NULL DEFAULT ('active'),
        "lastProvider" varchar,
        "totalTokens" integer NOT NULL DEFAULT (0),
        "metadata" text NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_conversations_userId" ON "conversations" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_conversations_userId_status" ON "conversations" ("userId", "status")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_conversations_userId_createdAt" ON "conversations" ("userId", "createdAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE "ai_messages" (
        "id" varchar PRIMARY KEY NOT NULL,
        "conversationId" varchar NOT NULL,
        "role" varchar NOT NULL,
        "content" text NOT NULL,
        "promptTokens" integer,
        "completionTokens" integer,
        "totalTokens" integer,
        "citations" text,
        "provider" varchar,
        "model" varchar,
        "latencyMs" integer,
        "flagged" boolean NOT NULL DEFAULT (0),
        "flagReason" varchar,
        "redacted" boolean NOT NULL DEFAULT (0),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "FK_ai_messages_conversationId" FOREIGN KEY ("conversationId")
          REFERENCES "conversations" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_ai_messages_conversationId" ON "ai_messages" ("conversationId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_messages_conversationId_createdAt" ON "ai_messages" ("conversationId", "createdAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE "ai_context_documents" (
        "id" varchar PRIMARY KEY NOT NULL,
        "title" varchar NOT NULL,
        "category" varchar NOT NULL,
        "content" text NOT NULL,
        "tags" text NOT NULL,
        "sourceUrl" varchar,
        "isActive" boolean NOT NULL DEFAULT (1),
        "createdBy" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_ai_context_documents_category" ON "ai_context_documents" ("category")`);
    await queryRunner.query(`CREATE INDEX "IDX_ai_context_documents_isActive" ON "ai_context_documents" ("isActive")`);

    await queryRunner.query(`
      CREATE TABLE "ai_usage_logs" (
        "id" varchar PRIMARY KEY NOT NULL,
        "userId" varchar NOT NULL,
        "conversationId" varchar,
        "messageId" varchar,
        "provider" varchar NOT NULL,
        "model" varchar,
        "endpoint" varchar NOT NULL,
        "status" varchar NOT NULL,
        "promptTokens" integer NOT NULL DEFAULT (0),
        "completionTokens" integer NOT NULL DEFAULT (0),
        "totalTokens" integer NOT NULL DEFAULT (0),
        "latencyMs" integer NOT NULL DEFAULT (0),
        "cacheHit" boolean NOT NULL DEFAULT (0),
        "errorCode" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_ai_usage_logs_userId" ON "ai_usage_logs" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_ai_usage_logs_userId_createdAt" ON "ai_usage_logs" ("userId", "createdAt")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_usage_logs_provider_createdAt" ON "ai_usage_logs" ("provider", "createdAt")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_ai_usage_logs_status" ON "ai_usage_logs" ("status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_ai_usage_logs_status"`);
    await queryRunner.query(`DROP INDEX "IDX_ai_usage_logs_provider_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_ai_usage_logs_userId_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_ai_usage_logs_userId"`);
    await queryRunner.query(`DROP TABLE "ai_usage_logs"`);

    await queryRunner.query(`DROP INDEX "IDX_ai_context_documents_isActive"`);
    await queryRunner.query(`DROP INDEX "IDX_ai_context_documents_category"`);
    await queryRunner.query(`DROP TABLE "ai_context_documents"`);

    await queryRunner.query(`DROP INDEX "IDX_ai_messages_conversationId_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_ai_messages_conversationId"`);
    await queryRunner.query(`DROP TABLE "ai_messages"`);

    await queryRunner.query(`DROP INDEX "IDX_conversations_userId_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_conversations_userId_status"`);
    await queryRunner.query(`DROP INDEX "IDX_conversations_userId"`);
    await queryRunner.query(`DROP TABLE "conversations"`);
  }
}
