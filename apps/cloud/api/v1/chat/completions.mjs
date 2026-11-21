import { handleChat } from '../../../lib/relay.mjs';

export function POST(request) {
  return handleChat(request, process.env);
}
