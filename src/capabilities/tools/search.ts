import { ToolModule } from '../../foundations/contracts/tool.js';

export const SearchTool: ToolModule = {
  name: "Web Search (Tavily)",
  risk: "safe",
  configKeys: ["tavilyApiKey"],
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for real-time information. Returns a summary of search results.",
      parameters: {
        type: "object",
        properties: {
          query: { 
            type: "string", 
            description: "The search query (e.g., 'latest openclaw news', 'nodejs documentation')." 
          },
          depth: {
            type: "string",
            enum: ["basic", "advanced"],
            description: "Search depth. 'basic' is faster, 'advanced' scrapes more content."
          }
        },
        required: ["query"]
      }
    }
  }
};
