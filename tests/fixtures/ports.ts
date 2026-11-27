import { createServer } from 'node:net';
import { randomInt } from 'node:crypto';

/** This PC allocates ephemeral ports from 1024, including ports rejected by Fetch. */
export async function fixturePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = createServer();
    const port = randomInt(20_000, 60_000);
    const opened = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (!opened) continue;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    return port;
  }
  throw new Error('Could not allocate a fixture HTTP port.');
}
