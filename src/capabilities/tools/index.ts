import { ToolModule } from '../../foundations/contracts/tool.js';
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

// Central registry of capability-owned tools.
// Domain-owned tools (e.g. use_skill) are added by the Domain's tool executor.
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
  EditFileTool
];
