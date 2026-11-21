import { handleHealth } from '../lib/relay.mjs';

export function GET() {
  return handleHealth(process.env);
}
