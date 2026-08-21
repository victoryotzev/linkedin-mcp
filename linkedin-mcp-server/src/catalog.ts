import type { AppContext } from './bootstrap.ts';
import { requireFeatureEnabled } from '@linkedin-mcp/domain';
import { featureForTool } from './featureRouting.ts';
import { analyticsTools } from './tools/analytics.ts';
import { capabilityTools } from './tools/capabilities.ts';
import { changesetTools } from './tools/changesets.ts';
import { claimTools } from './tools/claims.ts';
import { contentTools } from './tools/content.ts';
import { externalTools } from './tools/external.ts';
import { maintenanceTools } from './tools/maintenance.ts';
import { onboardingTools } from './tools/onboarding.ts';
import { profileTools } from './tools/profile.ts';
import { publishTools } from './tools/publish.ts';
import { settingsTools } from './tools/settings.ts';
import { sourceTools } from './tools/sources.ts';

export function toolDefs(ctx: AppContext) {
  const tools = [
    ...capabilityTools(ctx),
    ...settingsTools(ctx),
    ...sourceTools(ctx),
    ...claimTools(ctx),
    ...profileTools(ctx),
    ...changesetTools(ctx),
    ...contentTools(ctx),
    ...publishTools(ctx),
    ...analyticsTools(ctx),
    ...externalTools(ctx),
    ...maintenanceTools(ctx),
    ...onboardingTools(ctx),
  ];
  return tools.map((tool) => {
    const feature = featureForTool(tool.name);
    if (feature === null) return tool;
    return {
      ...tool,
      handler: async (input: never) => {
        requireFeatureEnabled(ctx.db, feature);
        return await tool.handler(input);
      },
    } as typeof tool;
  });
}
