import { handleModels } from '../../lib/relay.mjs';

export function GET(request) {
  return handleModels(request, process.env);
}
