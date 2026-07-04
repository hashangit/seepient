# Seepient Agent - Complete Feature Documentation

**Version:** 1.0.40
**License:** BSL 1.1 (Business Source License — source-available, free for non-commercial use)
**Repository:** https://github.com/hashangit/seepient

---

## Overview

Seepient Agent is an engineering-first headless AI agent framework designed for scalable automation in containerized environments. It combines LLM-powered decision making with 23 specialized tools to automate system administration, web operations, communications, media generation, and external API integration tasks.

---

## Complete Feature Matrix

| # | Feature Category | App/Technical Feature | Description (Technical) | User-Facing Feature | User Benefit |
|---|------------------|----------------------|------------------------|---------------------|--------------|
| **CORE AI AGENT CAPABILITIES** |
| 1 | LLM Integration | OpenAI SDK Integration | Full integration with OpenAI SDK supporting function calling and tool use | AI-Powered Assistant | Users can interact with an intelligent agent that understands natural language and executes complex tasks |
| 2 | Multi-Provider Support | OpenAI-Compatible API | Supports custom base URLs for alternative LLM endpoints (DeepSeek, LocalLLM, etc.) | Flexible AI Provider Choice | Users aren't locked into OpenAI; can use cheaper, self-hosted, or region-specific LLM providers |
| 3 | Model Selection | Configurable Model Parameter | Default model `gpt-4o` with CLI override via `-m` flag | Choose Your AI Model | Users can select the best model for their needs (speed vs. quality vs. cost) |
| 4 | Multi-Provider Architecture | Provider Factory Pattern | Abstract provider interface supporting OpenAI, Anthropic, GLM, and OpenAI-compatible endpoints | Provider Flexibility | Users can switch between different AI providers seamlessly |
| 5 | Provider Switching | Runtime Provider Selection | `/models` command to switch providers during interactive sessions | Dynamic Provider Choice | Users can change AI providers mid-conversation without restarting |
| 6 | Provider Configuration | Multi-Provider Setup Wizard | Interactive setup wizard supporting configuration of multiple providers simultaneously | Unified Configuration | All provider credentials managed in one place |
| 7 | Context Awareness | System Prompt Injection | Agent receives OS, architecture, working directory, and user info in system prompt | Environment-Aware Responses | AI understands the user's system context and provides relevant, accurate solutions |
| 8 | Conversation Memory | Multi-Turn Context Management | Maintains conversation history for follow-up questions and iterative problem solving | Natural Conversation Flow | Users can have back-and-forth dialogues, ask clarifying questions, and refine requests |
| 9 | Streaming UI | Ora Spinner Integration | Visual spinner displays during AI thinking/processing states | Visual Feedback | Users know the system is working and aren't left wondering if it's stuck |
| 10 | Interactive Mode | Chat Loop Architecture | Continuous conversation loop with readline interface (`?` prompt) | Conversational Interface | Users can work through complex problems iteratively with the AI assistant |
| 11 | Headless Mode | `--no-interactive` Flag | Execute single query and exit without entering chat loop | One-Shot Automation | Perfect for scripts, CI/CD pipelines, and automated workflows |
| 12 | Auto-Confirm Mode | `-y` / `--yes` Flag | Automatically approve all tool executions without user prompts | Unattended Operation | Enables fully automated scripts and batch processing without manual intervention |
| **CLI & USER INTERFACE** |
| 13 | Main Command | `seepient [query]` | Default chat command that starts interactive agent with optional initial query | Quick Start | Users can immediately start working by typing a single command |
| 14 | Setup Wizard | `seepient setup` Command | Interactive Inquirer-based configuration wizard | Guided Configuration | Users don't need to manually edit config files; wizard walks them through setup |
| 15 | Project Config | `seepient setup --project` | Saves configuration to project-level (`.seepient/setting.json`) | Per-Project Settings | Different projects can have different configurations (API keys, models, etc.) |
| 16 | Provider Selection | `-p, --provider <provider>` Flag | CLI flag to specify provider (openai-compatible|openai|anthropic|glm) | Provider Override | Users can override default provider per-command |
| 17 | Models Command | `/models` Interactive Command | In-chat command to switch between configured providers | Provider Switching | Change AI providers without leaving the conversation |
| 18 | Version Display | `-v` / `--version` Flag | Displays current version information | Version Tracking | Users can quickly check which version they're running |
| 19 | Colored Output | Chalk Terminal Styling | Color-coded output with bold, dim, and colored text | Readable Terminal Output | Important information stands out; easier to scan and understand |
| 20 | Graceful Exit | SIGINT/SIGTERM Handling | Proper cleanup on Ctrl+C or termination signals | Safe Interruption | Users can safely stop execution without corrupting files or leaving processes hanging |
| 21 | Help System | Commander.js Help | Built-in help displaying all commands and options | Self-Documenting CLI | Users can discover features without reading external documentation |
| **TOOL SYSTEM - SHELL & FILE OPERATIONS** |
| 22 | Shell Execution | `execute_shell_command` Tool | Execute any shell command with stdout/stderr capture | Run Any Command | Users can automate system administration, deployments, builds, and any CLI task |
| 23 | Command Rationale | Required Rationale Parameter | Tool requires explanation of why command should be run | Transparent Automation | Users understand what the AI is trying to do and why before it executes |
| 24 | User Confirmation | Interactive Approval Prompt | Shell commands require explicit user approval (bypassable with `-y`) | Safety Control | Prevents accidental destructive operations; user maintains final control |
| 25 | File Reading | `read_file` Tool | Read any file content with UTF-8 encoding | Access Any File | Users can ask AI to analyze configs, logs, source code, or any text file |
| 26 | File Writing | `write_file` Tool | Write content to files with auto-directory creation | Automated File Creation | AI can create scripts, configs, reports, or any file without manual intervention |
| 27 | Auto Directory Creation | Recursive mkdir Support | Automatically creates parent directories when writing files | No Path Errors | Users don't need to manually create directory structures |
| 28 | Date/Time Context | `get_current_datetime` Tool | Returns ISO format, local format, timezone, and weekday | Time-Aware Responses | AI can correctly interpret "yesterday", "next Monday", or time-sensitive queries |
| **TOOL SYSTEM - COMMUNICATION** |
| 29 | Email Sending | `send_email` Tool | SMTP-based email with attachment support | Send Emails Directly | Users can automate notifications, reports, alerts via email |
| 30 | SMTP Configuration | Configurable SMTP Settings | Host, port, user, password, sender address configuration | Use Any Email Provider | Works with Gmail, Outlook, corporate SMTP, or any mail server |
| 31 | Secure Email | SSL/TLS Support | Supports both secure (SSL/TLS) and non-secure connections | Secure Communications | Sensitive information can be sent encrypted |
| 32 | File Attachments | Attachment Support | Email tool supports file attachments | Send Files via Email | Automated reports, logs, or documents can be emailed directly |
| 33 | Feishu/Lark Integration | `send_notification` - Feishu | Feishu/Lark webhook integration with security keyword | Team Notifications (Feishu) | Chinese enterprise users can send alerts to Feishu group chats |
| 34 | DingTalk Integration | `send_notification` - DingTalk | DingTalk webhook integration with security keyword | Team Notifications (DingTalk) | Chinese enterprise users can send alerts to DingTalk group chats |
| 35 | WeCom Integration | `send_notification` - WeCom | WeChat Work webhook integration with security keyword | Team Notifications (WeChat) | Chinese enterprise users can send alerts to WeCom group chats |
| 36 | Auto Security Keyword | Security Keyword Auto-Prefix | Automatically prepends security keywords when configured | Secure Webhook Integration | Meets platform security requirements without manual configuration |
| 37 | Platform Detection | Platform-Specific Payloads | Formats notification payload based on target platform | Cross-Platform Support | Single command works across all major Chinese enterprise chat platforms |
| **TOOL SYSTEM - WEB & BROWSER** |
| 38 | Web Search | `webSearch` Tool | Tavily API integration for real-time web search | Access Current Information | AI isn't limited to training data; can find latest news, prices, facts |
| 39 | Search Depth | Configurable Depth (Basic/Advanced) | Search depth affects result comprehensiveness | Quality vs. Speed Control | Users can choose quick answers or deep research based on needs |
| 40 | AI-Generated Answers | Direct Answer Extraction | Returns AI-generated answer from search results | Concise Answers | Users get direct answers, not just links to click through |
| 41 | Search Results | Formatted Results Display | Returns titles, URLs, and content snippets (up to 5 results) | Source Verification | Users can see where information came from and verify accuracy |
| 42 | Browser Automation | `read_website` Tool | Playwright-based headless browser with Mozilla Readability | Extract Web Content | Users can ask AI to read and summarize any webpage |
| 43 | Content Extraction | Readability Integration | Extracts main article content, removing ads and navigation | Clean Article Text | Gets the actual content without boilerplate, ads, or menus |
| 44 | User Agent Spoofing | Custom User Agent | Browser uses realistic user agent string | Better Compatibility | Websites treat requests as real browsers, reducing blocks |
| 45 | Timeout Handling | 30-Second Page Load Timeout | Configurable timeout for slow-loading pages | Handles Slow Sites | Doesn't fail immediately on slow connections or heavy pages |
| 46 | Fallback Extraction | Raw Body Text Fallback | Falls back to raw HTML if Readability fails | Robust Extraction | Works even on non-article pages or unusual layouts |
| 47 | Screenshots | `take_screenshot` Tool | Playwright-based full-page or viewport screenshots | Capture Website Images | Users can automate screenshot collection for documentation, testing, monitoring |
| 48 | Full-Page Capture | Full-Page Screenshot Option | Can capture entire scrollable page height | Complete Page Capture | Gets everything, not just what's visible in viewport |
| 49 | Dynamic Content Wait | Configurable Wait Time | Can wait for dynamic content to load before capture | JavaScript Support | Captures pages after React/Vue/Angular content renders |
| 50 | Auto Font Detection | CJK/Emoji Font Detection | Detects missing fonts and suggests installation | Proper Character Rendering | Chinese/Japanese/Korean text and emojis render correctly |
| 51 | Auto Font Installation | Linux Font Installation Commands | Provides automatic font installation for Alpine/Debian/Ubuntu | Docker-Ready | Works in minimal containers without manual font setup |
| 52 | Chrome Channel Support | Chrome or Bundled Chromium | Supports system Chrome or Playwright's bundled Chromium | Flexible Deployment | Works whether Chrome is installed or not |
| 53 | High DPI Rendering | deviceScaleFactor: 2 | Renders at 2x resolution for crisp text and graphics | Professional Quality | Screenshots look sharp and professional |
| 54 | Locale Support | zh-CN Locale Configuration | Configures browser locale for proper regional rendering | Regional Accuracy | Dates, numbers, and text render correctly for Chinese locale |
| **TOOL SYSTEM - MEDIA GENERATION** |
| 55 | Text-to-Image | `generate_image` Tool | Generate images from text prompts using DALL-E or custom models | Create Custom Images | Users can generate illustrations, icons, mockups from descriptions |
| 56 | Image Variations | Variation Generation | Create variations of existing images | Iterate on Designs | Users can explore different versions of a concept |
| 57 | Image Editing | Image Editing with Masks | Edit specific parts of images using mask overlays | Precise Image Modification | Can remove objects, change backgrounds, or modify portions |
| 58 | Multi-Model Support | DALL-E 2, DALL-E 3, Doubao/Seedream | Supports multiple image generation models | Model Flexibility | Users can choose based on quality, cost, or availability |
| 59 | Resolution Control | Model-Specific Size Presets | Configurable image sizes appropriate for each model | Quality Control | Users can select resolution based on their needs |
| 60 | Quality Settings | HD Quality for DALL-E 3 | Standard or HD quality option for DALL-E 3 | Premium Quality Option | Can pay more for higher quality when needed |
| 61 | Style Control | Vivid/Natural Styles | Artistic style selection for DALL-E 3 | Artistic Direction | Can specify photorealistic vs. artistic rendering |
| 62 | Batch Generation | Multiple Images (n parameter) | Generate multiple images in single request | Explore Options | Get several variations to choose from |
| 63 | Auto Download | Automatic Image Saving | Downloads generated images to local output directory | Immediate Access | Images are ready to use locally without manual download |
| 64 | Auto-Fallback | DALL-E 3 to DALL-E 2 Fallback | Automatically falls back to DALL-E 2 for unsupported operations | Seamless Experience | Features work even if primary model doesn't support them |
| 65 | Prompt Optimization | `optimize_prompt` Tool | AI-powered prompt enhancement for better results | Better Image Quality | Users get higher quality images even with vague initial descriptions |
| 66 | Context-Aware Optimization | Optional Context Parameter | Can optimize prompts with task-specific context | Specialized Results | Optimization adapts to specific use cases (logos, art, photos) |
| **CONFIGURATION SYSTEM** |
| 67 | Hierarchical Config | 4-Tier Priority System | CLI args > Env vars > Project config > Global config | Flexible Configuration | Users can override settings at different levels for different scenarios |
| 68 | API Key Storage | Encrypted Config Storage | Secure storage of API keys in config files | Persistent Credentials | Don't need to re-enter API keys every session |
| 69 | Environment Variables | `.env` File Support | Load configuration from environment variables | CI/CD Integration | Secrets can be managed via environment in production |
| 70 | Global Config | `~/.seepient/setting.json` | User-level configuration applies to all projects | Default Settings | Set once, use everywhere; no repeated configuration |
| 71 | Project Config | `./.seepient/setting.json` | Project-specific configuration | Project Isolation | Different projects can use different models, API keys |
| 72 | Image Configuration | Separate Image API Settings | Independent API key and base URL for image generation | Multi-Service Support | Can use different providers for chat vs. images |
| 73 | Image Defaults | Default Size/Quality/Style/N | Configurable defaults for image generation parameters | Personalized Defaults | Set your preferred image settings once |
| 74 | SMTP Configuration | Full SMTP Settings | Host, port, user, password, from address configuration | Email Integration | Configure once, send emails anytime |
| 75 | Notification Config | Platform-Specific Settings | Separate webhook URLs and keywords per platform | Multi-Platform Alerts | Configure all notification channels in one place |
| 76 | Auto-Confirm Flag | Runtime autoConfirm Setting | Can be set via CLI `-y` or config file | Persistent Automation | Can make auto-confirm the default behavior |
| 77 | OpenAI Env Vars | `OPENAI_*` Environment Variables | Standard OpenAI environment variable support | Standard Integration | Works with existing OpenAI tooling and workflows |
| 78 | Service Env Vars | `SMTP_*`, `TAVILY_*`, `*_WEBHOOK` | Environment variables for all integrated services | Secret Management | Sensitive data can stay out of config files |
| **SETUP & ONBOARDING** |
| 79 | Interactive Setup | Inquirer-Based Wizard | Step-by-step interactive configuration process | Easy Onboarding | New users can get started without reading docs |
| 80 | API Key Input | Masked Password Input | API keys are hidden during input | Secure Entry | Shoulder-surfing protection during setup |
| 81 | Optional Services | Conditional Service Prompts | Only asks about services user wants to configure | Customized Setup | Users aren't overwhelmed with irrelevant configuration |
| 82 | Secret Preservation | Preserve Existing Secrets | Doesn't overwrite existing secrets when left empty | Safe Re-Configuration | Can update some settings without losing others |
| 83 | Auto Directory Creation | Config Directory Creation | Automatically creates `~/.seepient` or `.seepient/` directories | No Manual Setup | Users don't need to create directories manually |
| 84 | Secure Permissions | 0o600 File Permissions | Config files created with owner-read-write only | File Security | Sensitive credentials protected from other users |
| **DOCKER & CONTAINERIZATION** |
| 85 | Headless Design | No GUI Dependencies | Designed to run without display or desktop environment | Container-Native | Runs in minimal Docker containers without X11 |
| 86 | Minimal Footprint | Lightweight Resource Usage | Optimized for low memory and CPU usage | Cost-Effective | Can run on small, cheap container instances |
| 87 | Non-Interactive Default | Designed for Automation | Default behavior suited for scripted execution | CI/CD Ready | Perfect for automated pipelines |
| 88 | Alpine Support | Alpine Linux Compatibility | Works on ultra-minimal Alpine Linux distributions | Minimal Images | Can use smallest possible container images |
| 89 | Debian/Ubuntu Support | Debian/Ubuntu Compatibility | Works on standard Debian and Ubuntu containers | Standard Images | Compatible with most common base images |
| 90 | Container Fonts | Auto CJK/Emoji Font Installation | Detects and installs fonts in container environments | Proper Rendering in Containers | Chinese/Japanese text renders correctly even in minimal containers |
| 91 | Font Detection | Multi-Distribution Font Paths | Checks font paths across different Linux distributions | Cross-Distro Support | Works regardless of container base image |
| 92 | fc-list Fallback | Font-Config Detection | Uses `fc-list` as fallback font detection method | Robust Detection | Finds fonts even without standard paths |
| **DEVELOPMENT & BUILD** |
| 93 | TypeScript | TypeScript 5.9+ | Full TypeScript implementation with strict typing | Type Safety | Fewer bugs, better IDE support, self-documenting code |
| 94 | ES Modules | ES2022 Target with NodeNext | Modern ES module system with NodeNext resolution | Modern JavaScript | Benefits from latest JS features and optimizations |
| 95 | Source Maps | Source Map Generation | Debugging maps compiled code back to source | Easy Debugging | Stack traces point to original TypeScript, not compiled JS |
| 96 | Build System | pnpm Build Scripts | Production build compiles TypeScript to `dist/` | Optimized Distribution | Production code is compiled and optimized |
| 97 | Dev Mode | `pnpm run dev` | Development mode with ts-node for instant iteration | Fast Development | No build step needed during development |
| 98 | Install Scripts | Windows (.bat) and Unix (.sh) | Platform-specific installation scripts | Easy Installation | Users can install with single command on any OS |
| 99 | Global Binary | NPM Global Installation | Installs `seepient` command globally | System-Wide Access | Command available from any directory |
| 100 | Package Filtering | .npmignore Configuration | Excludes source and config from npm package | Clean Distribution | Users only get what they need |
| **ERROR HANDLING & RELIABILITY** |
| 101 | Signal Handling | SIGINT/SIGTERM Capture | Gracefully handles Ctrl+C and termination signals | Safe Interruption | Can stop without corrupting files or leaving orphans |
| 102 | Tool Error Capture | stdout/stderr Capture | Captures full output from failed commands | Detailed Diagnostics | Users can see exactly what went wrong |
| 103 | Network Errors | API Call Error Handling | Handles network failures, timeouts, API errors | Resilient Operation | Doesn't crash on transient network issues |
| 104 | Browser Detection | Playwright Installation Check | Detects if Playwright/browsers are installed | Clear Error Messages | Users know what's missing and how to fix it |
| 105 | Config Validation | API Key Presence Checks | Validates required API keys before operations | Early Failure | Fails fast with clear message if not configured |
| 106 | Detailed Errors | Server Response Codes | Includes HTTP status codes and response bodies in errors | Actionable Errors | Users can diagnose and fix issues |
| 107 | Stack Traces | Error Stack Output | Full stack traces for debugging | Developer-Friendly | Developers can trace bugs to source |
| **SECURITY** |
| 108 | API Key Masking | Setup Wizard Input Masking | API keys hidden with password-style input | Credential Protection | Prevents visual exposure during setup |
| 109 | File Permissions | 0o600 Config File Permissions | Config files readable/writable only by owner | Access Control | Other users on system can't read credentials |
| 110 | Env Var Support | Environment Variable Alternative | Can use env vars instead of config files | Secret Management | Production secrets never touch disk |
| 111 | Git Ignore | .gitignore for Config | Config directories excluded from git | Accidental Commit Prevention | Won't accidentally commit API keys to repo |
| 112 | NPM Ignore | .npmignore for Source | Source code excluded from npm package | Clean Distribution | Installed package doesn't include dev files |
| 113 | Interactive Confirmation | Shell Command Approval | Requires explicit user approval for shell commands | User Control | Prevents unauthorized system modifications |
| 114 | Rationale Display | Command Explanation | Shows reasoning before executing commands | Transparency | Users understand why each action is taken |
| 115 | CI/CD Auto-Confirm | `-y` Flag for Pipelines | Can disable confirmations for automated runs | Automation-Friendly | Works in non-interactive CI/CD environments |
| **INTEGRATIONS ECOSYSTEM** |
| 116 | OpenAI | OpenAI API | Full OpenAI API integration for chat and images | Industry-Leading AI | Access to GPT-4, DALL-E 3, and latest models |
| 117 | DeepSeek | DeepSeek Compatibility | Works with DeepSeek's OpenAI-compatible API | Cost-Effective Alternative | Cheaper alternative for budget-conscious users |
| 118 | LocalLLM | Self-Hosted LLM Support | Works with local LLM servers (Ollama, LM Studio, etc.) | Privacy & Control | Run AI locally with full data privacy |
| 119 | Any OpenAI-Compatible | Custom Base URL | Works with any OpenAI-compatible API endpoint | Future-Proof | Compatible with new providers as they emerge |
| 120 | Tavily | Tavily Web Search API | Real-time web search with AI-generated answers | Current Information | Not limited to training data cutoff |
| 121 | SMTP | Any SMTP Server | Works with any standard SMTP email server | Universal Email | Compatible with Gmail, Outlook, corporate mail |
| 122 | Feishu/Lark | Feishu Bot Webhooks | Native integration with Feishu/Lark chat platform | Chinese Enterprise Ready | Popular in Chinese companies |
| 123 | DingTalk | DingTalk Bot Webhooks | Native integration with DingTalk chat platform | Chinese Enterprise Ready | Popular in Chinese companies |
| 124 | WeCom | WeChat Work Bot Webhooks | Native integration with WeCom chat platform | Chinese Enterprise Ready | Popular in Chinese companies |
| 125 | Playwright | Playwright Browser Automation | Full headless browser automation via Playwright | Reliable Browser Control | Industry-standard browser automation |
| 126 | Mozilla Readability | Readability.js Integration | Article extraction using Mozilla's algorithm | Clean Content | Removes ads, navigation, boilerplate |
| 127 | JSDOM | JSDOM HTML Parsing | HTML parsing and manipulation | Robust Parsing | Handles malformed or complex HTML |
| **USE CASES & APPLICATIONS** |
| 128 | System Administration | Shell Command Execution | Automate sysadmin tasks via natural language | No Script Writing | Admin tasks done by asking, not scripting |
| 129 | File Operations | Read/Write Files | Automated file I/O operations | Batch Processing | Process hundreds of files automatically |
| 130 | Web Scraping | Browser + Readability | Extract content from websites | Data Collection | Gather information from web automatically |
| 131 | Information Retrieval | Web Search | Real-time search for current information | Up-to-Date Answers | Get latest info beyond training data |
| 132 | Email Automation | SMTP Email Sending | Automated email notifications and reports | Scheduled Reports | Send daily/weekly reports automatically |
| 133 | Team Alerts | Multi-Platform Notifications | Send alerts to team chat platforms | Incident Response | Automated alerts when things break |
| 134 | Documentation | Screenshots | Automated screenshot capture | Visual Documentation | Create docs with automatic screenshots |
| 135 | Image Creation | AI Image Generation | Generate images from text descriptions | Custom Graphics | Create illustrations without designer |
| 136 | Script Generation | AI + Shell Execution | AI writes and executes scripts on the fly | No Coding Required | Complex tasks done without programming |
| 137 | Log Analysis | File Reading + AI | AI analyzes log files and summarizes | Quick Debugging | Understand logs without reading all |
| 138 | Container Automation | Docker-Optimized Design | Runs in containers for automated workflows | DevOps Automation | Automate deployments, monitoring, scaling |
| 139 | CI/CD Integration | Headless + Auto-Confirm | Integrates with CI/CD pipelines | Automated Testing | AI can run tests, analyze results, fix issues |
| **GATEWAY & API INTEGRATION** |
| 140 | Gateway Engine | MCPGateway Core Engine | MCP client management, REST proxying, routing, tool extraction, audit logging | Universal API Hub | Connect to any MCP server or REST API through a single gateway |
| 141 | MCP Client | MCP Client SDK Integration | Connect to MCP servers via stdio, SSE, or HTTP transports with auto-discovery | MCP Protocol Support | Use any Model Context Protocol server as a tool provider |
| 142 | REST Proxy | Secure REST API Proxying | Proxy REST calls with automatic credential injection (bearer, header, basic, query) | Secure API Access | API keys stored once, injected automatically on every call |
| 143 | OpenAPI Import | OpenAPI Spec Auto-Adapter | Fetch and parse OpenAPI specs (JSON/YAML), auto-register all operations as a REST target | One-Click API Setup | Import any OpenAPI spec and immediately use its endpoints as tools |
| 144 | Semantic Injection | Semantic Tool Injection Middleware | Keyword-based relevance scoring injects top-K most relevant gateway tools per request | Zero Context Pollution | Only the tools relevant to the user's request are visible to the LLM |
| 145 | Proxy Tools | 10 Gateway Proxy Tools | Generic tools (gateway_route, gateway_call_tool, etc.) for agent-facing gateway operations | Agent Self-Service | LLM discovers and navigates gateway targets autonomously |
| 146 | Credential Trust Guard | Admin vs Agent Target Trust | Agent-registered targets cannot resolve credential: prefixes; only admin targets can | Security Isolation | Prevents crafted targets from leaking stored credentials |
| 147 | Gateway Audit Log | Audit Trail & Usage Stats | Ring-buffer audit logs with per-target call/error counts, self-healing via agent tools | Observability | Debug failed API calls and monitor usage without external tools |
| 148 | Gateway Settings | Gateway Settings Category | 4 typed settings (enabled, semanticTopK, rateLimit, maxAuditLogs) + dedicated storage adapter | Configurable Gateway | Tune injection budget, rate limits, and audit retention |
| 149 | Gateway CLI | /gateway Slash Command | Full management: list, add, remove, toggle targets; manage routes, credentials, view audit logs | CLI Management | Manage the gateway without leaving the interactive session |
| 150 | Gateway REST API | Gateway REST Endpoints | 11 REST endpoints under /v1/gateway/* for target CRUD, credentials, routes, imports, audit | API Management | Manage the gateway via REST API for automation and scripts |
| 151 | Gateway SDK | SDK Gateway Namespace | Lazy-loaded gateway.createGateway() for programmatic gateway creation | Programmatic Access | Integrate gateway into custom applications and workflows |
| **INTERACTION PATTERNS** |
| 152 | Natural Language | Query-Based Commands | Users type requests in plain English/Chinese | No Learning Curve | Just ask like you would a human |
| 153 | Multi-Turn Dialogue | Conversation History | Back-and-forth conversation for complex tasks | Iterative Refinement | Can clarify and refine requests |
| 154 | Tool Suggestion | AI Proposes Tools | AI explains which tool it will use and why | Transparency | Users understand AI's approach |
| 155 | Context Awareness | System Info in Prompts | AI knows OS, directory, time, user | Relevant Responses | Solutions are tailored to user's environment |
| 156 | Exit Commands | `exit` / `quit` | Natural language commands to end session | Intuitive Control | End session naturally |
| **TECHNICAL SPECIFICATIONS** |
| 157 | Node.js Runtime | Node.js v18+ | Requires Node.js 18 or higher | Modern Platform | Benefits from latest Node.js features |
| 158 | TypeScript | TypeScript 5.9+ | Written in TypeScript with full type safety | IDE Support | Great autocomplete and error detection |
| 159 | Commander.js | Commander.js 14.x | CLI framework for command parsing | Standard CLI | Familiar interface for Node.js users |
| 160 | Inquirer | Inquirer 13.x | Interactive prompt system | Beautiful Prompts | Professional-looking setup wizard |
| 161 | Chalk | Chalk 5.x | Terminal string styling | Colorful Output | Easy to read terminal output |
| 162 | Ora | Ora 9.x | Terminal spinner | Visual Feedback | Animated spinners for async operations |
| 163 | OpenAI SDK | OpenAI 6.x | Official OpenAI SDK | Reliable Integration | Official support and latest features |
| 164 | Playwright | Playwright 1.58+ | Browser automation library | Robust Automation | Industry-standard browser control |
| 165 | Nodemailer | Nodemailer 8.x | Email sending library | Universal Email | Works with any SMTP server |
| 166 | Dotenv | Dotenv 16.x | Environment variable loading | Easy Configuration | Load secrets from `.env` file |
| 167 | MCP SDK | `@modelcontextprotocol/sdk` | MCP client for connecting to downstream MCP servers | Protocol Standard | Industry-standard protocol for tool and resource sharing |
| 168 | js-yaml | js-yaml | YAML parsing for OpenAPI spec import | YAML Support | Most real-world OpenAPI specs use YAML format |
| **PACKAGE INFORMATION** |
| 169 | Version | 1.0.40 | Current release version | Stable Release | Production-ready software |
| 170 | License | BSL 1.1 | Business Source License — source-available | Free for Non-Commercial | Personal/eval use free; commercial use requires license |
| 171 | NPM Package | `seepient` | Published on NPM registry | Easy Installation | `npm install -g seepient-core` |
| 172 | GitHub Repo | hashangit/seepient | Source code on GitHub | Open Development | Can contribute, report issues, fork |
| 173 | Keywords | ai, cli, agent, automation, openai, docker, headless, devops, llm, typescript, orchestration, infrastructure, terminal | Package keywords | Discoverable | Easy to find via search |

---

## TUI & Interactive Experience (Interactive Mode)

In a TTY the CLI launches a full-screen Ink/React TUI (`src/adapters/cli/tui/`, lazy-loaded — headless/SDK/Server never import React/Ink/figlet). The readline REPL remains as the non-interactive fallback (`--no-interactive` / piped / `--docker`). The TUI renders via Ink `<Static>` + the terminal's native scrollback (no mouse capture → no gibberish; no alternate-screen buffer), with an Ink-internals reset (`ink-reset.ts`) for artifact-free resize/expand.

| Feature | Description |
|---------|-------------|
| Bordered persistent input | The prompt row is wrapped in a rounded box and is always visible; during a run the spinner renders above it (not in place of it) and the input stays active. |
| `/` + `@` autocomplete | Fuzzy slash-command/skill dropdown (`/`) and project-file dropdown (`@`) floating above the input border; ↑/↓ navigate, Tab/Enter accept, multi-line via Shift+Enter. |
| Seepient Agent logo | A figlet "Seepient Agent" wordmark (`ANSI Compact`) with a Tokyo Night 45° rainbow gradient + `by hashangit · v…` descriptor; the first feed entry, scrolls away as you chat, re-seeded on `/clear`. |
| Persistent task panel | The `manage_todos` tool drives a persistent todo panel (status glyphs); the agent replaces the full list each call, and it survives session resume. |
| Streaming feed | Assistant responses stream token-by-token; tool calls render as live bordered blocks with streaming output; Markdown rendering for messages. |
| Inline write diffs | `write_file` renders a unified diff (green added / red removed, context-collapse) inside the tool block. Writes are atomic (same-dir temp + `fs.rename`), so a crash mid-write never corrupts the file; oversized writes skip the diff and show a plain summary. |
| Overlays | Command palette (Ctrl+P), model selector (`/models`), settings editor (`/settings`), session selector (`/sessions`), help (`/?`). |
| Session manager | List / resume / delete / rename / export (JSON) / transcript (Markdown) sessions; resume rebuilds the feed **and** the todo panel from persisted messages. |
| Message queue + `/steer` | Type during a run to queue follow-up messages; `/steer <msg>` interrupts the current run and redirects. |
| Live footer | Provider · model · context-window usage · cost · permission · skills · gateway status, updating live. |
| Tokyo Night theme | Consistent Tokyo Night Moon palette across all components from a single theme source. |

---

## Feature Summary Statistics

| Category | Count |
|----------|-------|
| **Core AI Agent Features** | 12 |
| **CLI & User Interface** | 9 |
| **Shell & File Tools** | 7 |
| **Communication Tools** | 9 |
| **Web & Browser Tools** | 17 |
| **Media Generation Tools** | 12 |
| **Configuration System** | 12 |
| **Setup & Onboarding** | 6 |
| **Docker & Containerization** | 8 |
| **Development & Build** | 8 |
| **Error Handling & Reliability** | 7 |
| **Security Features** | 8 |
| **Integrations** | 12 |
| **Use Cases** | 12 |
| **Gateway & API Integration** | 12 |
| **Interaction Patterns** | 5 |
| **Technical Specifications** | 12 |
| **Package Information** | 5 |
| **TOTAL FEATURES** | **173** |

---

## Tool Inventory

| Tool Name | Category | User Confirmation Required | API Key Required |
|-----------|----------|---------------------------|------------------|
| `execute_shell_command` | System | Yes (unless `-y`) | No |
| `read_file` | File I/O | No | No |
| `write_file` | File I/O | No | No |
| `get_current_datetime` | System | No | No |
| `send_email` | Communication | No | Yes (SMTP) |
| `send_notification` | Communication | No | Yes (Webhook) |
| `webSearch` | Web | No | Yes (Tavily) |
| `read_website` | Web/Browser | No | No |
| `take_screenshot` | Web/Browser | No | No |
| `generate_image` | Media | No | Yes (Image API) |
| `optimize_prompt` | Media | No | No (uses chat API) |
| `use_skill` | Skills | No | No |
| `manage_todos` | Presentation | No | No |
| `gateway_route` | Gateway | No | No |
| `gateway_call_tool` | Gateway | No | No |
| `gateway_call_rest` | Gateway | No | No |
| `gateway_capabilities` | Gateway | No | No |
| `gateway_read_resource` | Gateway | No | No |
| `gateway_get_prompt` | Gateway | No | No |
| `gateway_import_openapi` | Gateway | No | No |
| `gateway_register_target` | Gateway | No | No |
| `gateway_audit_log` | Gateway | No | No |
| `gateway_usage_stats` | Gateway | No | No |

---

## Configuration Options

| Configuration Key | Type | Default | Description |
|-------------------|------|---------|-------------|
| `apiKey` | String | - | OpenAI/LLM API key |
| `baseUrl` | String | OpenAI default | Custom API endpoint URL |
| `model` | String | `gpt-4o` | Default LLM model |
| `imageApiKey` | String | - | Separate API key for image generation |
| `imageBaseUrl` | String | - | Custom base URL for image service |
| `imageModel` | String | - | Default image generation model |
| `imageSize` | String | Model default | Default image size |
| `imageQuality` | String | `standard` | Default image quality |
| `imageStyle` | String | `vivid` | Default image style |
| `imageN` | Number | 1 | Default number of images |
| `smtpHost` | String | - | SMTP server host |
| `smtpPort` | Number | - | SMTP server port |
| `smtpUser` | String | - | SMTP username |
| `smtpPass` | String | - | SMTP password |
| `smtpFrom` | String | - | Sender email address |
| `tavilyApiKey` | String | - | Tavily web search API key |
| `feishuWebhook` | String | - | Feishu webhook URL |
| `feishuKeyword` | String | - | Feishu security keyword |
| `dingtalkWebhook` | String | - | DingTalk webhook URL |
| `dingtalkKeyword` | String | - | DingTalk security keyword |
| `wecomWebhook` | String | - | WeCom webhook URL |
| `wecomKeyword` | String | - | WeCom security keyword |
| `autoConfirm` | Boolean | false | Auto-confirm tool executions |
| `gateway.enabled` | Boolean | true | Enable the MCP gateway subsystem (restart required) |
| `gateway.semanticTopK` | Number | 3 | Number of most relevant gateway tools to inject per request (1-10) |
| `gateway.defaultRateLimitPerMin` | Number | 60 | Default rate limit for gateway API calls per minute |
| `gateway.maxAuditLogs` | Number | 1000 | Maximum audit log records retained in memory (10-10000) |

---

## Supported Platforms

| Platform | Support Level | Notes |
|----------|---------------|-------|
| **macOS** | Full Support | All features work natively |
| **Linux** | Full Support | All features; auto font installation for containers |
| **Windows** | Full Support | All features; install script provided |
| **Docker (Alpine)** | Full Support | Auto font installation included |
| **Docker (Debian)** | Full Support | Auto font installation included |
| **Docker (Ubuntu)** | Full Support | Auto font installation included |
| **CI/CD Systems** | Full Support | Headless mode and auto-confirm for automation |

---

## Quick Start Commands

```bash
# Install globally
npm install -g seepient

# Run interactive mode
seepient

# Run with initial query
seepient "List all files in current directory"

# Run headless (one-shot)
seepient --no-interactive "Summarize README.md"

# Run with auto-confirm
seepient -y "Delete all .log files"

# Run with specific model
seepient -m "gpt-4-turbo" "Write a Python script"

# Run with specific provider
seepient -p anthropic "Generate code"

# Setup wizard
seepient setup

# Project-specific setup
seepient setup --project
```

---

## Documentation

- **README:** `/Users/hashanw/Developer/seepient/README.md`
- **Contributing Guide:** `/Users/hashanw/Developer/seepient/CONTRIBUTING.md`
- **GitHub:** https://github.com/hashangit/seepient
- **NPM:** https://www.npmjs.com/package/seepient

---

*This document was auto-generated to provide a comprehensive feature overview of Seepient Agent version 1.0.40.*
