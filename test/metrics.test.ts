import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../src/observability/metrics.js";

describe("MetricsRegistry", () => {
  it("只聚合狀態與耗時，不保存請求正文或憑據", () => {
    let nowMs = Date.parse("2026-08-16T00:00:00.000Z");
    const registry = new MetricsRegistry(() => nowMs, nowMs);

    registry.recordMcpHttpResponse(401, 5, false);
    registry.recordMcpHttpResponse(200, 12, true);
    registry.recordToolCall(9, false);
    registry.recordToolCall(4, true);
    registry.recordPingCodeRequest(429, 20);
    registry.recordPingCodeRetry();
    registry.recordPingCodeRequest(200, 8);
    registry.recordPingCodeRequest(undefined, 3);
    nowMs += 5000;

    expect(registry.snapshot()).toEqual({
      generatedAt: "2026-08-16T00:00:05.000Z",
      uptimeSeconds: 5,
      mcpHttp: {
        requestsTotal: 2,
        authenticatedRequestsTotal: 1,
        responsesByStatus: { "200": 1, "401": 1 },
        durationMsTotal: 17,
      },
      tools: {
        callsTotal: 2,
        failuresTotal: 1,
        durationMsTotal: 13,
      },
      pingcodeApi: {
        requestsTotal: 3,
        failuresTotal: 2,
        retriesTotal: 1,
        rateLimitedTotal: 1,
        durationMsTotal: 31,
      },
    });
  });
});
