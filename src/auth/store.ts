import { randomUUID } from "node:crypto";
import { TokenCipher } from "./token-cipher.js";

export interface RawOAuthStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  consume(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  compareAndDelete(key: string, expectedValue: string): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface OAuthStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  consume(key: string): Promise<unknown | undefined>;
  delete(key: string): Promise<void>;
  withLock<T>(key: string, action: () => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export class EncryptedOAuthStore implements OAuthStore {
  constructor(
    private readonly rawStore: RawOAuthStore,
    private readonly cipher: TokenCipher,
  ) {}

  async get(key: string): Promise<unknown | undefined> {
    const value = await this.rawStore.get(key);
    return value === undefined ? undefined : this.decode(value);
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.rawStore.set(key, this.encode(value), ttlSeconds);
  }

  async consume(key: string): Promise<unknown | undefined> {
    const value = await this.rawStore.consume(key);
    return value === undefined ? undefined : this.decode(value);
  }

  delete(key: string): Promise<void> {
    return this.rawStore.delete(key);
  }

  async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const lockKey = `lock:${key}`;
    const lockValue = randomUUID();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await this.rawStore.setIfAbsent(lockKey, lockValue, 130)) {
        try {
          return await action();
        } finally {
          await this.rawStore.compareAndDelete(lockKey, lockValue);
        }
      }
      await delay(100);
    }
    throw new Error("等待 OAuth Token 更新鎖逾時");
  }

  ping(): Promise<void> {
    return this.rawStore.ping();
  }

  close(): Promise<void> {
    return this.rawStore.close();
  }

  private encode(value: unknown): string {
    return this.cipher.encrypt(JSON.stringify(value));
  }

  private decode(value: string): unknown {
    return JSON.parse(this.cipher.decrypt(value)) as unknown;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
