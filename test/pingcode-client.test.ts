import { describe, expect, it, vi } from "vitest";
import type { AccessTokenProvider } from "../src/pingcode/access-token-provider.js";
import { PingCodeClient } from "../src/pingcode/client.js";
import { PingCodeError } from "../src/pingcode/errors.js";
import { silentLogger } from "./helpers.js";

describe("PingCodeClient", () => {
  it("429 時遵守 Retry-After 並在上限內重試", async () => {
    const tokenProvider = createTokenProvider();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{}", { status: 429, headers: { "Retry-After": "3" } }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    const client = createClient(tokenProvider, fetchMock, sleep, {
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 2000,
    });

    await expect(client.get("/v1/wiki/pages/page-1")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("401 時只刷新一次 Token 後重試", async () => {
    const tokenProvider = createTokenProvider();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    const client = createClient(tokenProvider, fetchMock, sleep);

    await expect(client.get("/v1/wiki/pages/page-1")).resolves.toEqual({ ok: true });
    expect(tokenProvider.invalidate).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("403 等不可重試錯誤立即返回", async () => {
    const tokenProvider = createTokenProvider();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 403 }));
    const sleep = vi.fn(async () => undefined);
    const client = createClient(tokenProvider, fetchMock, sleep);

    const error = await client.get("/v1/wiki/pages/page-1").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PingCodeError);
    expect(error).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("網路逾時只重試配置次數，之後返回穩定錯誤", async () => {
    const tokenProvider = createTokenProvider();
    const fetchMock = vi.fn(async () => {
      throw new DOMException("請求逾時", "AbortError");
    });
    const sleep = vi.fn(async () => undefined);
    const client = createClient(tokenProvider, fetchMock, sleep, {
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    });

    const error = await client.get("/v1/wiki/pages/page-1").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PingCodeError);
    expect(error).toMatchObject({ code: "TIMEOUT" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 50);
    expect(sleep).toHaveBeenNthCalledWith(2, 100);
  });
});

function createTokenProvider() {
  const provider = {
    getAccessToken: vi.fn(async () => "test-access-token"),
    invalidate: vi.fn(() => undefined),
  } satisfies AccessTokenProvider;
  return provider;
}

function createClient(
  tokenProvider: AccessTokenProvider,
  fetchMock: ReturnType<typeof vi.fn>,
  sleep: (milliseconds: number) => Promise<void>,
  retryOptions: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  } = {},
): PingCodeClient {
  return new PingCodeClient(
    "https://open.pingcode.example",
    tokenProvider,
    1000,
    1024 * 1024,
    silentLogger,
    fetchMock as typeof fetch,
    {
      ...retryOptions,
      random: () => 0,
      sleep,
    },
  );
}
