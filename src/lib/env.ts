/** Load .env for the standalone scripts. Next.js does this for the app already. */
export function loadEnv(path = '.env'): void {
  try { process.loadEnvFile(path); } catch { /* absent in deployed environments */ }
}
