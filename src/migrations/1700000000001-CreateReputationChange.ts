import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateReputationChange1700000000001 implements MigrationInterface {
    name = 'CreateReputationChange1700000000001'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "reputation_changes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" character varying NOT NULL, "oldScore" integer NOT NULL, "newScore" integer NOT NULL, "delta" integer NOT NULL, "stakeAmount" numeric, "isCorrect" boolean NOT NULL DEFAULT false, "verificationId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_5c3f7c2a9f6c1a2b3d4e5f6a7b8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_reputation_user" ON "reputation_changes" ("userId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_reputation_user"`);
        await queryRunner.query(`DROP TABLE "reputation_changes"`);
    }

}
