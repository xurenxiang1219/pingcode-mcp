import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

export function loadEnvironment(): void {
  const configuredPath = process.env.PINGCODE_ENV_FILE?.trim();
  const defaultPath = fileURLToPath(new URL("../.env", import.meta.url));

  loadDotenv({
    path: configuredPath || defaultPath,
    quiet: true,
  });
}
