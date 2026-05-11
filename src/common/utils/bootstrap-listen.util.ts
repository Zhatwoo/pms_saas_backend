import type { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { execSync } from 'node:child_process';

function tryReleaseListeningPort(port: number, logger: Logger): void {
  try {
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "` +
          `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; ` +
          `if ($c) { $c | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { ` +
          `Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }` +
          `"`,
        { stdio: 'ignore', windowsHide: true },
      );
    } else {
      execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, {
        stdio: 'ignore',
      });
    }
  } catch {
    logger.warn(
      `RELEASE_PORT_BEFORE_LISTEN was set but port ${port} could not be freed automatically.`,
    );
  }
}

/**
 * Binds the Nest HTTP server with explicit logging and optional fallback when the preferred port is busy.
 */
export async function listenNestApplication(
  app: INestApplication,
  logger: Logger,
  options: { preferredPort: number; fallbackPort?: number; host?: string },
): Promise<number> {
  const host = options.host ?? '0.0.0.0';
  const { preferredPort, fallbackPort } = options;

  if (process.env.RELEASE_PORT_BEFORE_LISTEN === 'true') {
    logger.warn(
      `RELEASE_PORT_BEFORE_LISTEN=true: attempting to free port ${preferredPort} before listen (dev/local only).`,
    );
    tryReleaseListeningPort(preferredPort, logger);
  }

  try {
    await app.listen(preferredPort, host);
    logger.log(
      `Listening at http://${host}:${preferredPort} (NODE_ENV=${process.env.NODE_ENV ?? 'undefined'}, PORT=${preferredPort})`,
    );
    return preferredPort;
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as NodeJS.ErrnoException).code)
        : '';

    if (code === 'EADDRINUSE') {
      logger.error(
        `Port ${preferredPort} is already in use (EADDRINUSE). Use a different PORT in .env, stop the existing Nest/other process, set PORT_FALLBACK, or for local dev only set RELEASE_PORT_BEFORE_LISTEN=true.`,
      );

      if (fallbackPort != null && fallbackPort > 0 && fallbackPort !== preferredPort) {
        if (process.env.RELEASE_PORT_BEFORE_LISTEN === 'true') {
          tryReleaseListeningPort(fallbackPort, logger);
        }
        logger.warn(`Retrying bind on PORT_FALLBACK=${fallbackPort}`);
        await app.listen(fallbackPort, host);
        logger.log(
          `Listening at http://${host}:${fallbackPort} (fallback; configure clients to match this PORT)`,
        );
        return fallbackPort;
      }
    }

    throw err;
  }
}
