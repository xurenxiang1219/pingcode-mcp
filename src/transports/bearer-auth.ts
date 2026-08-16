import type { RequestHandler } from "express";
import {
  InsufficientScopeError,
  InvalidTokenError,
  OAuthError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthInfo;
  }
}

interface SafeBearerAuthOptions {
  verifier: OAuthTokenVerifier;
  requiredScopes?: string[];
  resourceMetadataUrl?: string;
}

/**
 * SDK 的預設 Bearer middleware 會把中文 OAuth 錯誤訊息直接放進 Header，
 * Node.js 會因此拒絕非 Latin-1 字元。這裡保留中文 JSON 錯誤，Header 使用固定 ASCII 描述。
 */
export function requireSafeBearerAuth({
  verifier,
  requiredScopes = [],
  resourceMetadataUrl,
}: SafeBearerAuthOptions): RequestHandler {
  return async (request, response, next) => {
    try {
      const authorization = request.headers.authorization;
      const match = authorization?.match(/^Bearer\s+(\S+)$/i);
      const token = match?.[1];
      if (!token) {
        throw new InvalidTokenError("缺少或無效的 Authorization Header");
      }

      const authInfo = await verifier.verifyAccessToken(token);
      if (requiredScopes.length > 0) {
        const hasAllScopes = requiredScopes.every((scope) => authInfo.scopes.includes(scope));
        if (!hasAllScopes) {
          throw new InsufficientScopeError("目前 Token 的權限範圍不足");
        }
      }
      if (typeof authInfo.expiresAt !== "number" || Number.isNaN(authInfo.expiresAt)) {
        throw new InvalidTokenError("Token 缺少有效的到期時間");
      }
      if (authInfo.expiresAt < Date.now() / 1000) {
        throw new InvalidTokenError("Token 已過期");
      }

      request.auth = authInfo;
      next();
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        response.set(
          "WWW-Authenticate",
          buildWwwAuthenticate(error.errorCode, requiredScopes, resourceMetadataUrl),
        );
        response.status(401).json(error.toResponseObject());
        return;
      }
      if (error instanceof InsufficientScopeError) {
        response.set(
          "WWW-Authenticate",
          buildWwwAuthenticate(error.errorCode, requiredScopes, resourceMetadataUrl),
        );
        response.status(403).json(error.toResponseObject());
        return;
      }
      if (error instanceof ServerError) {
        response.status(500).json(error.toResponseObject());
        return;
      }
      if (error instanceof OAuthError) {
        response.status(400).json(error.toResponseObject());
        return;
      }
      response.status(500).json(new ServerError("伺服器內部錯誤").toResponseObject());
    }
  };
}

function buildWwwAuthenticate(
  errorCode: string,
  requiredScopes: string[],
  resourceMetadataUrl?: string,
): string {
  const parts = [
    `Bearer error="${quoteHeaderValue(errorCode)}"`,
    `error_description="${quoteHeaderValue(headerDescription(errorCode))}"`,
  ];
  if (requiredScopes.length > 0) {
    parts.push(`scope="${quoteHeaderValue(requiredScopes.join(" "))}"`);
  }
  if (resourceMetadataUrl) {
    parts.push(`resource_metadata="${quoteHeaderValue(resourceMetadataUrl)}"`);
  }
  return parts.join(", ");
}

function headerDescription(errorCode: string): string {
  if (errorCode === "insufficient_scope") {
    return "The request requires higher privileges";
  }
  return "The access token is invalid or expired";
}

function quoteHeaderValue(value: string): string {
  return value
    .replace(/[\\"]/g, "\\$&")
    .replace(/[\x00-\x1f\x7f]/g, "?")
    .replace(/[^\x20-\x7e]/g, "?");
}
