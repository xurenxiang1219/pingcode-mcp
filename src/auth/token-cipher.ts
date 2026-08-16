import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export class TokenCipher {
  private readonly key: Buffer;

  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, "base64");
    if (this.key.length !== 32) {
      throw new Error("MCP_OAUTH_ENCRYPTION_KEY 必須是 Base64 編碼的 32-byte 金鑰");
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(value: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext] = value.split(".");
    if (version !== VERSION || !encodedIv || !encodedTag || encodedCiphertext === undefined) {
      throw new Error("OAuth 儲存資料格式無效");
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(encodedIv, "base64url"));
      decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      throw new Error("無法解密 OAuth 儲存資料", { cause: error });
    }
  }
}
