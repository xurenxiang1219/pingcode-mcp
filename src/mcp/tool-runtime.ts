import { ZodError } from "zod";
import type { Logger } from "../logger.js";
import { metrics } from "../observability/metrics.js";
import { PingCodeError } from "../pingcode/errors.js";

export async function executeTool<T extends object>(
  logger: Logger,
  toolName: string,
  requestId: string | number,
  fields: Record<string, unknown>,
  action: () => Promise<T>,
) {
  const startedAt = Date.now();
  const context = { requestId: String(requestId), toolName, ...fields };
  logger.info("開始執行 PingCode MCP Tool", context);
  try {
    const result = await action();
    const durationMs = Date.now() - startedAt;
    metrics.recordToolCall(durationMs, false);
    logger.info("PingCode MCP Tool 執行完成", {
      ...context,
      status: "success",
      durationMs,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    metrics.recordToolCall(durationMs, true);
    return failure(error, logger, {
      ...context,
      status: "failure",
      durationMs,
    });
  }
}

export function requestIdForLog(
  headerValue: string | string[] | undefined,
  fallback: string | number,
): string {
  return Array.isArray(headerValue)
    ? (headerValue[0] ?? String(fallback))
    : (headerValue ?? String(fallback));
}

function failure(error: unknown, logger: Logger, context: Record<string, unknown>) {
  if (error instanceof PingCodeError) {
    logger.warn("PingCode MCP Tool 執行失敗", {
      ...context,
      code: error.code,
      status: error.options.status,
      upstreamRequestId: error.options.requestId,
      retryable: error.retryable,
    });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              ...(error.options.requestId ? { requestId: error.options.requestId } : {}),
              ...(error.options.retryAfterSeconds === undefined
                ? {}
                : { retryAfterSeconds: error.options.retryAfterSeconds }),
            },
          }),
        },
      ],
    };
  }

  if (error instanceof ZodError) {
    logger.warn("PingCode 返回的資料不符合預期結構", {
      ...context,
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: {
              code: "INVALID_RESPONSE",
              message: "PingCode 返回的資料不符合預期結構",
              retryable: false,
            },
          }),
        },
      ],
    };
  }

  logger.error("MCP Tool 發生非預期錯誤", {
    ...context,
    errorName: error instanceof Error ? error.name : typeof error,
  });
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: {
            code: "INTERNAL_ERROR",
            message: "PingCode MCP Tool 發生非預期錯誤",
            retryable: false,
          },
        }),
      },
    ],
  };
}
