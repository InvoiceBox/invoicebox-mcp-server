import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_TOKEN_FILE = join(homedir(), '.invoicebox', 'mcp-token');

export interface TokenFileResult {
  token: string;
  warnings: string[];
}

/**
 * Токен в переменной окружения виден родительскому процессу и файлам конфигурации клиентов,
 * поэтому поддерживается файл с правами только для владельца: https://docs.invoicebox.ru/mcp/security/
 */
export async function readTokenFile(path = DEFAULT_TOKEN_FILE): Promise<TokenFileResult | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }

  const token = raw.trim();
  if (token === '') return undefined;

  const warnings: string[] = [];
  if (process.platform !== 'win32') {
    const info = await stat(path);
    const mode = info.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warnings.push(`файл ${path} доступен не только владельцу (${mode.toString(8)}) — исправьте права на 600`);
    }
  }
  return { token, warnings };
}

export async function writeTokenFile(token: string, path = DEFAULT_TOKEN_FILE): Promise<void> {
  if (token.trim().length < 8) throw new Error('токен короче восьми символов не бывает');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${token.trim()}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
