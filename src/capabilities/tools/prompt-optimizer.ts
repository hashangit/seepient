import { ToolModule } from '../../foundations/contracts/tool.js';
import { optimizePrompt } from '../media/media.js';

export const PromptOptimizerTool: ToolModule = {
  name: "Prompt Optimizer",
  risk: "safe",
  definition: {
    type: "function",
    function: {
      name: "optimize_prompt",
      description: "Optimize a user's raw task description or prompt to be more professional, structured, and effective. STRONGLY RECOMMENDED for creative tasks (like image generation) or complex scripts to ensure high-quality results.",
      parameters: {
        type: "object",
        properties: {
          raw_prompt: {
            type: "string",
            description: "The original, raw prompt or task description provided by the user."
          },
          context: {
            type: "string",
            description: "Optional context about the goal, audience, or specific requirements (e.g., 'for an image generator', 'for a code reviewer')."
          }
        },
        required: ["raw_prompt"]
      }
    }
  },
  handler: async (args: any, config: any) => {
    return optimizePrompt(args.raw_prompt, args.context, config ?? {});
  }
};
