import { describe, it, expect } from "vitest";
import { withApp, registerTestUser } from "../helpers/withApp";
import { mockQueues } from "../helpers/queueMock";

mockQueues();

describe("auth", () => {
  const ctx = withApp();

  it("registers a new account and returns tokens + person", async () => {
    const res = await ctx.request().post("/api/v1/auth/register").send({
      email: "alice@example.com",
      password: "hunter2hunter2",
      name: "Alice",
    });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTypeOf("string");
    expect(res.body.refreshToken).toBeTypeOf("string");
    expect(res.body.person.name).toBe("Alice");
    expect(res.body.person.status).toBe("active");
  });

  it("rejects registration missing required fields", async () => {
    const res = await ctx.request().post("/api/v1/auth/register").send({ email: "x@example.com" });
    expect(res.status).toBe(400);
  });

  it("logs in with correct credentials and rejects wrong password", async () => {
    await registerTestUser(ctx.request, { email: "bob@example.com", password: "correcthorse" });

    const good = await ctx.request().post("/api/v1/auth/login").send({
      email: "bob@example.com",
      password: "correcthorse",
    });
    expect(good.status).toBe(200);
    expect(good.body.accessToken).toBeTypeOf("string");

    const bad = await ctx.request().post("/api/v1/auth/login").send({
      email: "bob@example.com",
      password: "wrong",
    });
    expect(bad.status).toBe(401);
  });

  it("refreshes tokens from a valid refresh token", async () => {
    const user = await registerTestUser(ctx.request);
    const res = await ctx.request().post("/api/v1/auth/refresh").send({ refreshToken: user.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf("string");
  });

  it("rejects an invalid refresh token", async () => {
    const res = await ctx.request().post("/api/v1/auth/refresh").send({ refreshToken: "garbage" });
    expect(res.status).toBe(401);
  });
});
