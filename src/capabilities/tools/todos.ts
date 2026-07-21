import { ToolModule } from '../../foundations/contracts/tool.js';

/**
 * manage_todos — a presentation tool that lets the agent maintain a visible
 * task list in the TUI feed. The agent replaces the full list each call (not
 * append). The TUI's tool-call-block detects this tool's output (JSON) and
 * renders it via the GoalStatus component (status glyphs, not a plain block).
 *
 * Risk: "safe" — no side effects, auto-approved.
 */
export const TodoTool: ToolModule = {
  name: 'Task Tracker',
  risk: 'safe',
  definition: {
    type: 'function',
    function: {
      name: 'manage_todos',
      description:
        'Track tasks/todos with status. Call this to create or update a visible ' +
        'task list in the TUI. Replace the full list each time (not append). Use ' +
        'proactively for multi-step work so the user can see progress.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The complete todo list (all items, with current statuses).',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string', description: 'What needs to be done' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'blocked'],
                  description: 'Current status of the task',
                },
              },
              required: ['description', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  handler: async (args: any) => {
    const todos = args.todos;
    if (!Array.isArray(todos)) return 'Error: todos must be an array.';
    // Return structured JSON; the TUI parses it into a GoalStatus view.
    return JSON.stringify(todos);
  },
};
