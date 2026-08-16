import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";

describe("logger secret redaction", () => {
  it("redacts OAuth and Redis secrets recursively", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      createLogger("info").info("測試遮蔽", {
        redisUrl: "redis://user:password@example.internal",
        encryptionKey: "encryption-key-value",
        nested: {
          refreshToken: "refresh-token-value",
          clientId: "client-id-value",
        },
      });
      const output = String(write.mock.calls[0]?.[0]);
      expect(output).not.toContain("password");
      expect(output).not.toContain("encryption-key-value");
      expect(output).not.toContain("refresh-token-value");
      expect(output).not.toContain("client-id-value");
      expect(output).toContain("[REDACTED]");
    } finally {
      write.mockRestore();
    }
  });
});
