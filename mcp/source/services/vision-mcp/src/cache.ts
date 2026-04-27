import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface CacheEnvelope<T> {
  createdAt: string;
  value: T;
}

function jsonPath(cacheDir: string, key: string): string {
  return path.join(cacheDir, `${key}.json`);
}

function binPath(cacheDir: string, key: string): string {
  return path.join(cacheDir, `${key}.bin`);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function ensureCacheDir(cacheDir: string): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
}

export async function getJsonCache<T>(
  cacheDir: string,
  key: string,
  ttlMs: number,
): Promise<T | null> {
  const target = jsonPath(cacheDir, key);

  try {
    const meta = await stat(target);
    if (Date.now() - meta.mtimeMs > ttlMs) {
      return null;
    }

    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    return parsed.value;
  } catch {
    return null;
  }
}

export async function setJsonCache<T>(
  cacheDir: string,
  key: string,
  value: T,
): Promise<void> {
  await ensureCacheDir(cacheDir);
  const payload: CacheEnvelope<T> = {
    createdAt: new Date().toISOString(),
    value,
  };
  await writeFile(jsonPath(cacheDir, key), JSON.stringify(payload, null, 2), "utf8");
}

export async function getBinaryCache(
  cacheDir: string,
  key: string,
  ttlMs: number,
): Promise<Buffer | null> {
  const target = binPath(cacheDir, key);

  try {
    const meta = await stat(target);
    if (Date.now() - meta.mtimeMs > ttlMs) {
      return null;
    }

    return await readFile(target);
  } catch {
    return null;
  }
}

export async function setBinaryCache(
  cacheDir: string,
  key: string,
  buffer: Buffer,
): Promise<void> {
  await ensureCacheDir(cacheDir);
  await writeFile(binPath(cacheDir, key), buffer);
}
