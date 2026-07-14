import { ToolModule } from './interface.js';
import { ShellTool, ReadFileTool, WriteFileTool, DateTimeTool } from './core.js';
import { TodoTool } from './todos.js';
import { EmailTool } from './email.js';
import { SearchTool } from './search.js';
import { NotifyTool } from './notify.js';
import { BrowserTool } from './browser.js';
import { ScreenshotTool } from './screenshot.js';
import { ImageTool } from './image.js';
import { PromptOptimizerTool } from './prompt-optimizer.js';
import { RenderWidgetTool } from './widgets.js';
import { EditFileTool } from './edit-file.js';
import { getSkillRegistry } from '../skills/index.js';
import { limitSkillBody } from '../skills/types.js';

const UseSkillTool: ToolModule = {
  name: "Skill Invocation",
  risk: "safe",
  definition: {
    type: "function",
    function: {
      name: "use_skill",
      description: "Load and activate a specific skill to gain specialized knowledge and procedures. Use when the user's request matches a skill's description.",
      parameters: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            description: "Name of the skill to activate (e.g. 'docker-ops', 'k8s-deploy')"
          },
          args: {
            type: "object",
            description: "Optional arguments to pass to the skill (e.g. {environment: 'staging', service: 'myapp'})",
            properties: {}
          }
        },
        required: ["skill_name"]
      }
    }
  },
  handler: async (args: any) => {
    const registry = getSkillRegistry();
    if (!registry) return "Error: Skill system not initialized.";

    const { skill_name, args: skillArgs } = args;
    const skill = registry.get(skill_name);
    if (!skill) {
      return `Error: Skill '${skill_name}' not found. Available skills: ${registry.getAll().map(s => s.name).join(', ')}`;
    }

    const body = await registry.getBody(skill_name);
    if (!body) return `Error: Skill '${skill_name}' has no content.`;

    // If skillArgs provided, substitute positional variables
    let resolvedBody = body;
    if (skillArgs && typeof skillArgs === 'object') {
      const argsValues = Object.values(skillArgs);
      if (argsValues.length > 0) {
        const { substituteArgs } = await import('../skills/args.js');
        resolvedBody = substituteArgs(body, {
          positional: argsValues.map(String),
          raw: argsValues.join(' '),
        });
      }
    }

    // Enforce body size limits
    const { body: limitedBody, truncated, originalTokenEstimate, finalTokenEstimate } =
      limitSkillBody(resolvedBody);

    let result = `# ${skill.name} Skill Activated\n\n${limitedBody}`;
    if (truncated) {
      result += `\n\n> Note: Skill body was truncated (${originalTokenEstimate} -> ${finalTokenEstimate} estimated tokens). The skill may not function as intended.`;
    }
    if (skillArgs && Object.keys(skillArgs).length > 0) {
      result += `\n\n## Skill Arguments\n${JSON.stringify(skillArgs, null, 2)}`;
    }

    return result;
  }
};

// Central Registry of all available tools
export const builtInTools: ToolModule[] = [
  ShellTool,
  ReadFileTool,
  WriteFileTool,
  DateTimeTool,
  TodoTool,
  PromptOptimizerTool,
  EmailTool,
  SearchTool,
  NotifyTool,
  BrowserTool,
  ScreenshotTool,
  ImageTool,
  RenderWidgetTool,
  EditFileTool,
  UseSkillTool
];
