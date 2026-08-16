import { describe, expect, it, vi } from "vitest";
import { CimdClientResolver } from "../src/auth/cimd-client-resolver.js";
import { silentLogger } from "./helpers.js";

const clientId = "https://client.example/mcp/client-metadata.json";

describe("CimdClientResolver", () => {
  it("resolves and caches a valid public CIMD client", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const requestDocument = vi.fn(async () => ({
      status: 200,
      contentType: "application/json; charset=utf-8",
      cacheControl: "public, max-age=600",
      body: JSON.stringify({
        client_id: clientId,
        client_name: "VS Code",
        redirect_uris: ["http://127.0.0.1:33418/"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    }));
    const resolver = new CimdClientResolver({
      logger: silentLogger,
      lookup,
      requestDocument,
    });

    await expect(resolver.resolve(clientId)).resolves.toMatchObject({
      client_id: clientId,
      client_name: "VS Code",
      redirect_uris: ["http://127.0.0.1:33418/"],
      token_endpoint_auth_method: "none",
    });
    await resolver.resolve(clientId);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(requestDocument).toHaveBeenCalledTimes(1);
  });

  it("returns undefined for a non-URL DCR client id", async () => {
    const lookup = vi.fn();
    const resolver = new CimdClientResolver({ logger: silentLogger, lookup });

    await expect(resolver.resolve("833ad636-6374-4608-9cff-ee6269741102")).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a client host that resolves to a special-use address", async () => {
    const requestDocument = vi.fn();
    const resolver = new CimdClientResolver({
      logger: silentLogger,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      requestDocument,
    });

    await expect(resolver.resolve(clientId)).rejects.toMatchObject({
      errorCode: "invalid_client_metadata",
    });
    expect(requestDocument).not.toHaveBeenCalled();
  });

  it("rejects metadata whose client id does not exactly match the document URL", async () => {
    const resolver = new CimdClientResolver({
      logger: silentLogger,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      requestDocument: async () => ({
        status: 200,
        contentType: "application/json",
        cacheControl: null,
        body: JSON.stringify({
          client_id: "https://attacker.example/client.json",
          redirect_uris: ["http://127.0.0.1:33418/"],
          token_endpoint_auth_method: "none",
        }),
      }),
    });

    await expect(resolver.resolve(clientId)).rejects.toThrow(
      "CIMD metadata 的 client_id 與文件 URL 不一致",
    );
  });

  it("enforces an optional client metadata host allowlist", async () => {
    const lookup = vi.fn();
    const resolver = new CimdClientResolver({
      logger: silentLogger,
      allowedHosts: ["trusted.example"],
      lookup,
    });

    await expect(resolver.resolve(clientId)).rejects.toThrow("CIMD Client host 不在允許清單中");
    expect(lookup).not.toHaveBeenCalled();
  });
});
