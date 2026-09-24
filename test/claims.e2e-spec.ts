import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";

import { AppModule } from "@/src/app.module";

describe("Claims (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule =
      await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /claims/:id should return 404 for unknown id", async () => {
    const unknownId = "non-existent-id";

    await request(app.getHttpServer())
      .get(`/claims/${unknownId}`)
      .expect(404)
      .expect((res) => {
        expect(res.body.message).toContain("not found");
      });
  });
});