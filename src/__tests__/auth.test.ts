import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth";

describe("auth utilities", () => {
  it("hashes and verifies a password correctly", async () => {
    const password = "supersecret123";
    const hash = await hashPassword(password);
    expect(hash).not.toBe(password);
    const valid = await verifyPassword(password, hash);
    expect(valid).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correctpassword");
    const valid = await verifyPassword("wrongpassword", hash);
    expect(valid).toBe(false);
  });
});
