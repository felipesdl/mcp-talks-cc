import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { learningPaths } from '../../learning/paths.ts';
import { readJson } from '../../learning/fsUtil.ts';
import { getTuning } from '../tuning.ts';
import type { Profile } from '../../learning/types.ts';

export function registerProfileResource(server: McpServer): void {
  server.registerResource(
    'memory://profile',
    'memory://profile',
    {
      description:
        'Learned profile of how you work (top projects, recurring topics, terminology, source-kind utility) plus active retrieval tuning and last self-tune eval. Built by `npm run self-tune` from graded query logs.',
    },
    async () => {
      const profile = await readJson<Profile>(learningPaths.profile);
      const payload = {
        profile: profile ?? 'no profile yet — run `npm run self-tune` after some search_memory usage',
        activeTuning: getTuning(),
        candidatePending: (await readJson<unknown>(learningPaths.tuningCandidate)) !== null,
      };
      return {
        contents: [
          {
            uri: 'memory://profile',
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );
}
