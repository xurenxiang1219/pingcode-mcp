import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export function requireMetricsBearerToken(expectedToken: string): RequestHandler {
  const expected = Buffer.from(expectedToken, "utf8");

  return (request, response, next) => {
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);
    const provided = match?.[1];
    if (!provided || !secureEqual(Buffer.from(provided, "utf8"), expected)) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="pingcode-mcp-metrics"');
      response.status(401).json({
        error: "unauthorized",
        message: "缺少或無效的 Metrics Bearer Token",
      });
      return;
    }
    next();
  };
}

function secureEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
