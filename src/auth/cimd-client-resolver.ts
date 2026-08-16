import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  OAuthClientInformationFullSchema,
  OAuthClientMetadataSchema,
  type OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import type { Logger } from "../logger.js";

const DEFAULT_CACHE_TTL_SECONDS = 5 * 60;
const MAX_CACHE_TTL_SECONDS = 10 * 60;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

const cimdDocumentSchema = OAuthClientMetadataSchema.extend({
  client_id: z.string().min(1),
});

const specialUseAddresses = createSpecialUseBlockLists();

export interface CimdDocumentResponse {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  body: string;
}

export interface CimdClientResolverLike {
  resolve(clientId: string): Promise<OAuthClientInformationFull | undefined>;
}

interface CimdClientResolverOptions {
  logger: Logger;
  allowedHosts?: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  requestDocument?: (
    url: URL,
    addresses: LookupAddress[],
    timeoutMs: number,
    maxResponseBytes: number,
  ) => Promise<CimdDocumentResponse>;
  now?: () => number;
}

interface CachedClient {
  client: OAuthClientInformationFull;
  expiresAtMs: number;
}

export class CimdClientResolver implements CimdClientResolverLike {
  private readonly cache = new Map<string, CachedClient>();
  private readonly allowedHosts: Set<string>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly lookup: (hostname: string) => Promise<LookupAddress[]>;
  private readonly requestDocument: NonNullable<CimdClientResolverOptions["requestDocument"]>;
  private readonly now: () => number;

  constructor(private readonly options: CimdClientResolverOptions) {
    this.allowedHosts = new Set(
      (options.allowedHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean),
    );
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.lookup = options.lookup ?? lookupPublicAddresses;
    this.requestDocument = options.requestDocument ?? requestCimdDocument;
    this.now = options.now ?? Date.now;
  }

  async resolve(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const url = parseCimdClientId(clientId);
    if (!url) {
      return undefined;
    }

    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAtMs > this.now()) {
      return cached.client;
    }
    this.cache.delete(clientId);

    if (this.allowedHosts.size > 0 && !this.allowedHosts.has(url.hostname.toLowerCase())) {
      throw invalidMetadata("CIMD Client host 不在允許清單中");
    }

    let addresses: LookupAddress[];
    try {
      addresses = await this.lookup(stripIpv6Brackets(url.hostname));
    } catch (error) {
      throw invalidMetadata("無法解析 CIMD Client host", error);
    }
    if (addresses.length === 0 || addresses.some((entry) => isSpecialUseAddress(entry.address))) {
      throw invalidMetadata("CIMD Client host 不得解析到特殊用途網路位址");
    }

    let response: CimdDocumentResponse;
    try {
      response = await this.requestDocument(
        url,
        addresses,
        this.timeoutMs,
        this.maxResponseBytes,
      );
    } catch (error) {
      throw invalidMetadata("無法取得 CIMD Client metadata", error);
    }
    if (response.status !== 200) {
      throw invalidMetadata("CIMD Client metadata 必須返回 HTTP 200");
    }
    if (!isJsonContentType(response.contentType)) {
      throw invalidMetadata("CIMD Client metadata 必須返回 JSON");
    }

    let rawDocument: unknown;
    try {
      rawDocument = JSON.parse(response.body) as unknown;
    } catch (error) {
      throw invalidMetadata("CIMD Client metadata 不是有效的 JSON", error);
    }
    if (hasForbiddenClientSecret(rawDocument)) {
      throw invalidMetadata("CIMD 公開 Client 不得包含 Client Secret");
    }

    const parsed = cimdDocumentSchema.safeParse(rawDocument);
    if (!parsed.success) {
      throw invalidMetadata("CIMD Client metadata 不符合預期資料結構", parsed.error);
    }
    if (parsed.data.client_id !== clientId) {
      throw invalidMetadata("CIMD metadata 的 client_id 與文件 URL 不一致");
    }
    if (parsed.data.redirect_uris.length === 0 || parsed.data.redirect_uris.length > 20) {
      throw invalidMetadata("CIMD metadata 必須包含 1 至 20 個 Redirect URI");
    }
    if (
      parsed.data.token_endpoint_auth_method !== undefined &&
      parsed.data.token_endpoint_auth_method !== "none"
    ) {
      throw invalidMetadata("CIMD 目前只支援公開 Client 的 none 認證方式");
    }
    if (
      parsed.data.grant_types !== undefined &&
      !parsed.data.grant_types.includes("authorization_code")
    ) {
      throw invalidMetadata("CIMD Client 必須支援 authorization_code");
    }
    if (
      parsed.data.response_types !== undefined &&
      !parsed.data.response_types.includes("code")
    ) {
      throw invalidMetadata("CIMD Client 必須支援 code response type");
    }

    const client = OAuthClientInformationFullSchema.parse({
      ...parsed.data,
      token_endpoint_auth_method: "none",
      client_id: clientId,
      client_id_issued_at: Math.floor(this.now() / 1000),
    });
    const cacheTtlSeconds = parseCacheTtlSeconds(response.cacheControl);
    if (cacheTtlSeconds > 0) {
      this.cache.set(clientId, {
        client,
        expiresAtMs: this.now() + cacheTtlSeconds * 1000,
      });
    }
    this.options.logger.debug("已解析 MCP CIMD Client metadata", {
      clientReference: createHash("sha256").update(clientId).digest("hex").slice(0, 12),
      clientHost: url.hostname,
      redirectUriCount: client.redirect_uris.length,
      cacheTtlSeconds,
    });
    return client;
  }
}

function parseCimdClientId(clientId: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") {
    return undefined;
  }
  if (
    url.pathname === "/" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    hasDotPathSegment(clientId)
  ) {
    throw invalidMetadata("CIMD client_id URL 不符合安全限制");
  }
  return url;
}

async function lookupPublicAddresses(hostname: string): Promise<LookupAddress[]> {
  if (isIP(hostname)) {
    return [{ address: hostname, family: isIP(hostname) }];
  }
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function requestCimdDocument(
  url: URL,
  addresses: LookupAddress[],
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<CimdDocumentResponse> {
  const selected = addresses[0];
  if (!selected) {
    return Promise.reject(new Error("CIMD host 沒有可用位址"));
  }

  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json, application/*+json",
          "User-Agent": "pingcode-mcp/0.1.0",
        },
        family: selected.family,
        lookup: (_hostname, _options, callback) => {
          callback(null, selected.address, selected.family);
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
          response.destroy(new Error("CIMD metadata 超過大小限制"));
          return;
        }

        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxResponseBytes) {
            response.destroy(new Error("CIMD metadata 超過大小限制"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            contentType: singleHeader(response.headers["content-type"]),
            cacheControl: singleHeader(response.headers["cache-control"]),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function isJsonContentType(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.match(/^application\/.+\+json$/));
}

function hasForbiddenClientSecret(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return "client_secret" in value || "client_secret_expires_at" in value;
}

function parseCacheTtlSeconds(value: string | null): number {
  if (!value || /(?:^|,)\s*no-store\s*(?:,|$)/i.test(value)) {
    return value ? 0 : DEFAULT_CACHE_TTL_SECONDS;
  }
  const match = value.match(/(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i);
  if (!match) {
    return DEFAULT_CACHE_TTL_SECONDS;
  }
  return Math.min(Number(match[1]), MAX_CACHE_TTL_SECONDS);
}

function isSpecialUseAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return specialUseAddresses.ipv4.check(address, "ipv4");
  }
  if (family === 6) {
    return specialUseAddresses.ipv6.check(address, "ipv6");
  }
  return true;
}

function createSpecialUseBlockLists(): { ipv4: BlockList; ipv6: BlockList } {
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  const ipv4Subnets: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  const ipv6Subnets: Array<[string, number]> = [
    ["::", 128],
    ["::1", 128],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ];
  for (const [network, prefix] of ipv4Subnets) {
    ipv4.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of ipv6Subnets) {
    ipv6.addSubnet(network, prefix, "ipv6");
  }
  return { ipv4, ipv6 };
}

function hasDotPathSegment(value: string): boolean {
  const authorityEnd = value.indexOf("/", "https://".length);
  if (authorityEnd < 0) {
    return false;
  }
  const rawPath = value.slice(authorityEnd).split(/[?#]/, 1)[0] ?? "";
  return rawPath
    .split("/")
    .some((segment) => /^(?:\.|%2e|\.%2e|%2e\.|%2e%2e)$/i.test(segment));
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function singleHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function invalidMetadata(message: string, cause?: unknown): InvalidClientMetadataError {
  const error = new InvalidClientMetadataError(message);
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  }
  return error;
}
