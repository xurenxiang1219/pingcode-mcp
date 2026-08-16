import type { RawOAuthStore } from "./store.js";

interface Entry {
  value: string;
  expiresAtMs: number;
}

export class MemoryOAuthStore implements RawOAuthStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | undefined> {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAtMs: this.now() + ttlSeconds * 1000 });
  }

  async consume(key: string): Promise<string | undefined> {
    const value = await this.get(key);
    this.entries.delete(key);
    return value;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if ((await this.get(key)) !== undefined) {
      return false;
    }
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async compareAndDelete(key: string, expectedValue: string): Promise<void> {
    if ((await this.get(key)) === expectedValue) {
      this.entries.delete(key);
    }
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    this.entries.clear();
  }
}
