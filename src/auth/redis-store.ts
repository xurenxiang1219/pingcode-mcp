import { createClient } from "redis";
import type { RawOAuthStore } from "./store.js";

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export class RedisOAuthStore implements RawOAuthStore {
  private readonly client: ReturnType<typeof createClient>;

  constructor(redisUrl: string) {
    this.client = createClient({ url: redisUrl });
    this.client.on("error", () => {
      // Redis 錯誤會由當次操作傳回；此處不得輸出可能包含連線資訊的內容。
    });
  }

  async connect(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.client.get(this.key(key))) ?? undefined;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(this.key(key), value, { EX: ttlSeconds });
  }

  async consume(key: string): Promise<string | undefined> {
    return (await this.client.getDel(this.key(key))) ?? undefined;
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.key(key));
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    return (await this.client.set(this.key(key), value, { EX: ttlSeconds, NX: true })) === "OK";
  }

  async compareAndDelete(key: string, expectedValue: string): Promise<void> {
    await this.client.eval(RELEASE_LOCK_SCRIPT, {
      keys: [this.key(key)],
      arguments: [expectedValue],
    });
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async close(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  private key(key: string): string {
    return `pingcode-mcp:oauth:${key}`;
  }
}
