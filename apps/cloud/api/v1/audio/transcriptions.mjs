import { handleTranscription } from '../../../lib/relay.mjs';

export function POST(request) {
  return handleTranscription(request, process.env);
}
