export interface MetricsSnapshot {
  generatedAt: string;
  uptimeSeconds: number;
  mcpHttp: {
    requestsTotal: number;
    authenticatedRequestsTotal: number;
    responsesByStatus: Record<string, number>;
    durationMsTotal: number;
  };
  tools: {
    callsTotal: number;
    failuresTotal: number;
    durationMsTotal: number;
  };
  pingcodeApi: {
    requestsTotal: number;
    failuresTotal: number;
    retriesTotal: number;
    rateLimitedTotal: number;
    durationMsTotal: number;
  };
}

export class MetricsRegistry {
  private readonly startedAtMs: number;
  private mcpRequestsTotal = 0;
  private mcpAuthenticatedRequestsTotal = 0;
  private readonly mcpResponsesByStatus = new Map<number, number>();
  private mcpDurationMsTotal = 0;
  private toolCallsTotal = 0;
  private toolFailuresTotal = 0;
  private toolDurationMsTotal = 0;
  private pingCodeRequestsTotal = 0;
  private pingCodeFailuresTotal = 0;
  private pingCodeRetriesTotal = 0;
  private pingCodeRateLimitedTotal = 0;
  private pingCodeDurationMsTotal = 0;

  constructor(
    private readonly now: () => number = Date.now,
    startedAtMs?: number,
  ) {
    this.startedAtMs = startedAtMs ?? now();
  }

  recordMcpHttpResponse(status: number, durationMs: number, authenticated: boolean): void {
    this.mcpRequestsTotal += 1;
    this.mcpDurationMsTotal += nonNegative(durationMs);
    this.mcpResponsesByStatus.set(status, (this.mcpResponsesByStatus.get(status) ?? 0) + 1);
    if (authenticated) {
      this.mcpAuthenticatedRequestsTotal += 1;
    }
  }

  recordToolCall(durationMs: number, failed: boolean): void {
    this.toolCallsTotal += 1;
    this.toolDurationMsTotal += nonNegative(durationMs);
    if (failed) {
      this.toolFailuresTotal += 1;
    }
  }

  recordPingCodeRequest(status: number | undefined, durationMs: number): void {
    this.pingCodeRequestsTotal += 1;
    this.pingCodeDurationMsTotal += nonNegative(durationMs);
    if (status === undefined || status >= 400) {
      this.pingCodeFailuresTotal += 1;
    }
    if (status === 429) {
      this.pingCodeRateLimitedTotal += 1;
    }
  }

  recordPingCodeRetry(): void {
    this.pingCodeRetriesTotal += 1;
  }

  snapshot(): MetricsSnapshot {
    return {
      generatedAt: new Date(this.now()).toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((this.now() - this.startedAtMs) / 1000)),
      mcpHttp: {
        requestsTotal: this.mcpRequestsTotal,
        authenticatedRequestsTotal: this.mcpAuthenticatedRequestsTotal,
        responsesByStatus: Object.fromEntries(
          [...this.mcpResponsesByStatus.entries()]
            .sort(([left], [right]) => left - right)
            .map(([status, count]) => [String(status), count]),
        ),
        durationMsTotal: this.mcpDurationMsTotal,
      },
      tools: {
        callsTotal: this.toolCallsTotal,
        failuresTotal: this.toolFailuresTotal,
        durationMsTotal: this.toolDurationMsTotal,
      },
      pingcodeApi: {
        requestsTotal: this.pingCodeRequestsTotal,
        failuresTotal: this.pingCodeFailuresTotal,
        retriesTotal: this.pingCodeRetriesTotal,
        rateLimitedTotal: this.pingCodeRateLimitedTotal,
        durationMsTotal: this.pingCodeDurationMsTotal,
      },
    };
  }
}

export const metrics = new MetricsRegistry();

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
