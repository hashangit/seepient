---
title: Skills
description: Discover, load, and create reusable skill packages that extend Seepient Agent's capabilities.
---

# Skills

Skills are reusable instruction packages that give the agent specialized knowledge and procedures. They are loaded at runtime from directories and exposed to the LLM as the `use_skill` built-in tool.

## How skills work

Skills follow a two-phase lifecycle: **discovery** at startup, then **activation** on demand.

### Phase 1: Discovery (at startup)

When the application starts, `discoverSkills(cwd)` scans configured skill directories. For each `SKILL.md` file found:

1. `parseFrontmatter()` reads **only the YAML header** -- the body is discarded immediately.
2. A `Skill` object is created with metadata plus the `filePath` for later lazy loading.
3. Skills with duplicate names are resolved by `priority` (higher wins).

After discovery, `buildSkillCatalog(metadata)` generates a compact text block listing every skill's name, description, and tags. This catalog is injected into the system prompt via the `skillCatalog` option on `AgentLoopOptions`, so the LLM always knows what skills are available.

```
discoverSkills(cwd)
  ├── parseFrontmatter() for each SKILL.md  →  Skill objects (no bodies)
  ├── buildSkillCatalog(metadata)           →  "- docker-ops: Docker container management [docker, deployment]"
  └── Catalog appended to system prompt
```

### Phase 2: Activation (when invoked)

There are two distinct activation paths:

- **Slash command path** (CLI only): The user types `/skillname args`. The input is parsed, the skill body is loaded from disk, arguments are substituted, `@path` references are resolved, and the constructed prompt is sent to `runAgentLoop`.
- **use\_skill tool path** (all adapters): The AI decides to use a skill based on the catalog in its system prompt. It calls the `use_skill` tool. The tool handler loads the body, substitutes arguments, and returns the content as a tool result string.

See [Two invocation paths](#two-invocation-paths) for a detailed walkthrough of each path.

## Loading skills

### Automatic discovery

Skills are loaded automatically when you specify skill names:

```typescript
import { generateText } from "seepient";

const result = await generateText("Deploy the staging environment", {
  skills: ["docker-ops"],
  tools: ["core"],
});
```

### With createAgent

```typescript
import { createAgent } from "seepient";

const agent = await createAgent({
  skills: ["docker-ops", "code-review"],
  tools: ["core", "comm"],
});

const reply = await agent.chat("Review my latest commit");
```

## `initializeSkillRegistry()`

Bootstraps the skill registry by scanning skill directories. This is the public API for initializing skills programmatically:

```typescript
import { initializeSkillRegistry } from "seepient";

// Scan the current working directory and configured paths for skills
await initializeSkillRegistry(process.cwd());
```

Call this at application startup to ensure skills are discovered before the first agent invocation. Seepient Agent calls this automatically when you pass `skills` to `generateText()` or `createAgent()`, but you may call it explicitly to pre-load skills or inspect the registry.

## Skill search paths

Seepient Agent searches for skills in the following locations, in priority order:

| Priority | Path                            | Source                        |
| -------- | ------------------------------- | ----------------------------- |
| 1        | `SEEPIENT_SKILLS_PATH` env var     | Colon-separated custom paths  |
| 2        | `.seepient/skills/`                | Project-level skills          |
| 3        | `/mnt/skills/`                  | Docker volume mount           |
| 4        | Bundled `skills/` directory     | Shipped with Seepient Agent            |

Higher-priority paths override skills with the same name from lower-priority paths.

### Custom skill paths

```bash
# Multiple paths, colon-separated
export SEEPIENT_SKILLS_PATH=/opt/skills:/home/user/my-skills
```

```bash
# Disable bundled skills
export SEEPIENT_NO_BUNDLED_SKILLS=1
```

## Bundled skills

Seepient ships skills in the bundled `skills/` directory. They are discovered automatically (lowest priority, so project/user skills of the same name override them).

| Skill | Purpose |
| -------- | --------------------------------------------- |
| `design` | Entry point for **all** design work. A router that classifies the request, fetches the matching skill from the upstream [OpenDesign](https://github.com/nexu-io/open-design/tree/main/skills) catalogue, maps its tools to Seepient's, and follows it. Use for UI/UX, mockups, prototypes, branding, slides/decks, image generation/editing, video/motion, design systems, Figma work, and design review. |
| `docker-ops` | Docker container and image operations |
| `k8s-deploy` | Kubernetes deployment operations |
| `log-analyzer` | Log file analysis and triage |
| `speckit-*` | SpecKit spec-driven workflow (`analyze`, `checklist`, `clarify`, `constitution`, `implement`, `plan`, `specify`, `tasks`, `taskstoissues`) |

Activate any of them by name:

```typescript
import { generateText } from "seepient";

// Route any design request through the OpenDesign catalogue
await generateText("Design a dark-mode login screen for a fintech app", {
  skills: ["design"],
  tools: ["core", "comm", "advanced"],
});
```

:::info
`design` does not ship design procedures of its own. It fetches the upstream skill over the network on each invocation (sending the request externally), so it needs `read_website` available and outbound network access.
:::

## Skill metadata

Each skill exposes metadata for discovery and filtering:

```typescript
interface SkillMetadata {
  name: string;
  description: string;
  version: string;
  tags: string[];
  allowedTools?: string[];
}
```

## Creating custom skills

Skills are defined as `SKILL.md` files inside a named directory. The file uses YAML frontmatter followed by Markdown instructions:

### Directory structure

```
my-skills/
  docker-ops/
    SKILL.md
  code-review/
    SKILL.md
```

### SKILL.md format

```markdown
---
name: docker-ops
description: Docker container and image management operations
version: 1.2.0
author: engineering-team
tags:
  - docker
  - deployment
  - containers
allowedTools:
  - execute_shell_command
  - read_file
  - write_file
priority: 10
args:
  - environment
  - service
model:
  provider: anthropic
  model: claude-sonnet-4-6-20260320
---

# Docker Operations Skill

You are a Docker operations specialist. Follow these procedures:

## Building Images

When asked to build a Docker image:
1. Check for an existing Dockerfile using read_file
2. Run: `docker build -t $1-$2 .`
3. Verify the image was created successfully

## Deploying

When deploying to environment $1:
1. Pull the latest image
2. Stop the existing container: `docker stop $2`
3. Start the new container: `docker run -d --name $2 ...`
```

### Frontmatter fields

| Field           | Type       | Required | Description                                                      |
| --------------- | ---------- | -------- | ---------------------------------------------------------------- |
| `name`          | `string`   | Yes      | Unique skill identifier (used in `skills: [...]` option)         |
| `description`   | `string`   | Yes      | Short description shown to the LLM for skill selection           |
| `version`       | `string`   | No       | Semantic version (defaults to `"1.0.0"`)                        |
| `author`        | `string`   | No       | Skill author                                                     |
| `tags`          | `string[]` | No       | Tags for categorization                                          |
| `allowedTools`  | `string[]` | No       | Restrict which tools the agent can use when this skill is active |
| `priority`      | `number`   | No       | Higher priority wins when skills have the same name (default: 0) |
| `args`          | `string[]` | No       | Named arguments this skill accepts                               |
| `model`         | `object`   | No       | Per-skill model selection (see [Provider switching](#provider-switching)) |

## Argument substitution

Skill bodies support template variables that are replaced at invocation time.

### Positional arguments

Use `$1`, `$2`, ..., `$N` for positional arguments:

```markdown
Build and deploy the $2 service to the $1 environment.
```

Invoked as: `use_skill({ skill_name: "docker-ops", args: ["staging", "api-gateway"] })`

### Special variables

| Variable   | Description                                |
| ---------- | ------------------------------------------ |
| `$ALL`     | All arguments joined as a single string    |
| `$COUNT`   | Number of arguments passed                 |
| `$FIRST`   | First argument (same as `$1`)              |
| `$LAST`    | Last argument                              |

### Example with argument substitution

```markdown
---
name: deploy
description: Deploy a service to an environment
args:
  - environment
  - service
---

Deploy the $2 service to $1:

1. Build: `docker build -t $2:$1 .`
2. Push: `docker push registry/$2:$1`
3. Deploy: `kubectl apply -f k8s/$1/$2.yaml --namespace $1`
```

## The `use_skill` tool

Skills are exposed to the LLM as the `use_skill` built-in tool:

```typescript
// The LLM calls this automatically when a user request matches a skill
{
  name: "use_skill",
  arguments: {
    skill_name: "docker-ops",
    args: {
      environment: "staging",
      service: "api-gateway"
    }
  }
}
```

You do not call `use_skill` directly. The LLM decides when to activate a skill based on the user's request and the skill descriptions in its system prompt.

## @path file references

Skills support `@path` references that inline file contents:

```markdown
Review the code in @src/index.ts and check @package.json for dependencies.
```

Supported patterns:

| Pattern                 | Resolves to                               |
| ----------------------- | ----------------------------------------- |
| `@path/to/file`        | Relative to project root (`process.cwd()`) |
| `@seepient_documents/file` | `~/seepient_documents/file`                  |
| `@~/path/to/file`      | Explicit home directory path              |

Files are inlined with syntax highlighting. Limits:

| Limit | Value | Configurable |
| ----- | ----- | ------------ |
| References per input | 10 | No |
| Per-file size | 1 MB | No |
| Cumulative total across all inlined files | 2 MB | No |

When the cumulative total exceeds 2 MB, remaining references are skipped with a marker:

```
[Skipped: cumulative resolved size would exceed 2048KB limit]: @large-file.log
```

:::warning
All resolved paths must fall within the project root, `~/seepient_documents/`, or `~/.seepient/`. References outside these boundaries are rejected with an access-denied error.
:::

## Lazy body loading

Discovery reads only frontmatter (the YAML header) -- the skill body is never parsed at startup. This keeps startup fast regardless of how many skills are installed.

When a skill is invoked, `registry.getBody(name)` reads the file from disk via `skill.filePath`, extracts the body text after the `---` delimiter, and caches it in an LRU cache with a maximum of 5 entries. When the cache is full, the least-recently-used entry is evicted.

```typescript
// Internal flow in DefaultSkillRegistry
async getBody(name: string): Promise<string | undefined> {
  // 1. Check LRU cache
  const cached = this.bodyCache.get(name);
  if (cached !== undefined) return cached;

  // 2. Read from disk, extract body after frontmatter
  const content = await readFile(skill.filePath, 'utf-8');
  const body = extractBody(content);

  // 3. Cache and evict oldest if over capacity
  this.bodyCache.set(name, body);
  if (this.bodyCache.size > 5) { /* evict oldest */ }
}
```

The first invocation of any skill incurs a ~1--5 ms disk read, which is negligible compared to LLM API latency. At most 5 skill bodies are held in memory at once, regardless of the total number of installed skills.

## Skill catalog injection

After discovery, `buildSkillCatalog(metadata)` generates a compact text block from `SkillMetadata[]`. Each skill gets one line in the format `- name: description [tags]`, typically 40--80 characters.

The catalog is injected into the system prompt via the `skillCatalog` option on `AgentLoopOptions`. Inside `runAgentLoop`, it is appended to the existing system message:

```typescript
// In agent-loop.ts
if (skillCatalog && messages[0]?.role === 'system') {
  messages[0] = { ...messages[0], content: messages[0].content + '\n\n' + skillCatalog };
}
```

This works across all adapters (CLI, SDK, Server). Example of what the LLM sees:

```
AVAILABLE SKILLS (activate with use_skill tool):
- docker-ops: Docker container and image management operations [docker, deployment, containers]
- code-review: Perform code review [review, quality]
When a user request matches a skill, call use_skill with the skill name.
```

## Body size limits

Skill bodies are guarded by a three-layer defense against oversized context injection:

### Layer 1: Load-time warning (8K chars / ~2K tokens)

`parseFrontmatter()` in `parser.ts` checks the body length after extraction. If it exceeds the warning threshold, a `console.warn` is emitted. This is informational only -- the body is not modified.

```
[SKILLS] Warning: Skill "docker-ops" body is 12450 chars (~3113 tokens).
Consider trimming below 8000 chars for optimal context usage.
```

### Layer 2: Injection-time truncation (32K chars / ~8K tokens)

`limitSkillBody()` enforces a hard cap when the body is about to be injected. If the body exceeds the limit, it is truncated with a clear marker:

```
[... Skill body truncated: 45000 chars total, 32000 shown.
Reduce skill body size or set SEEPIENT_SKILL_BODY_MAX_CHARS to increase the limit. ...]
```

The function returns a `TruncationResult` with metadata about original and final sizes:

```typescript
interface TruncationResult {
  body: string;                  // The (possibly truncated) body
  truncated: boolean;            // Whether truncation was applied
  originalChars: number;         // Original size in characters
  originalTokenEstimate: number; // Estimated original tokens (chars / 4)
  finalChars: number;            // Final size in characters
  finalTokenEstimate: number;    // Estimated final tokens (chars / 4)
}
```

### Layer 3: Cumulative @path cap (2 MB total)

The `@path` resolver stops inlining files when the cumulative resolved content would exceed 2 MB. Remaining references are replaced with a skip marker.

### Configurable thresholds

| Environment variable              | Default  | Description                  |
| --------------------------------- | -------- | ---------------------------- |
| `SEEPIENT_SKILL_BODY_MAX_CHARS`      | `32000`  | Hard truncation limit        |
| `SEEPIENT_SKILL_BODY_WARN_CHARS`     | `8000`   | Soft warning threshold       |

:::tip
If a skill is being truncated, split it into multiple smaller skills or use `@path` references to load instructions from separate files instead of embedding everything in the body.
:::

## Provider switching

Skills can specify a preferred provider and model in their frontmatter:

```yaml
---
name: code-review
description: Perform thorough code review
model:
  provider: anthropic
  model: claude-sonnet-4-6-20260320
---
```

When a skill with a `model.provider` field is invoked, `createSkillProviderSwitcher()` in `src/core/skill-invoker.ts` handles the temporary switch:

1. Captures the current provider and model.
2. Creates a new provider instance if the skill specifies a different one.
3. After the skill execution completes, restores the original provider in a `finally` block.

```typescript
import { createSkillProviderSwitcher } from "seepient";

const switcher = createSkillProviderSwitcher({
  provider: currentProvider,
  model: 'gpt-4',
  models: config.models,  // Available provider configs with API keys
});

// Switch if the skill requires a different provider
const switched = await switcher.switchIfNeeded(skillResult);

try {
  await agent.chat(skillResult.prompt);
} finally {
  if (switched) switcher.restore();
}
```

:::info
Provider switching works across all adapters (CLI, SDK, Server), not just the CLI. If the required provider's API key is not configured, the switch is silently skipped and the default provider is used instead.
:::

## Two invocation paths

Skills can be activated in two ways: via CLI slash commands or via the `use_skill` tool. Both paths share the same argument substitution, @path resolution, and body size limits, but differ in how the result is delivered.

### Path A: CLI slash command

When the user types a slash-prefixed command in the CLI REPL:

```
User types: /docker-ops build myapp:latest --no-cache
```

Step-by-step flow:

1. **Parse**: `parseInvocation()` extracts the skill name and arguments.
   ```
   { skillName: "docker-ops", args: { positional: ["build", "myapp:latest", "--no-cache"], raw: "build myapp:latest --no-cache" } }
   ```
2. **Lookup**: `registry.get("docker-ops")` returns the skill metadata.
3. **Load body**: `registry.getBody("docker-ops")` reads the file from disk, caches in LRU.
4. **Substitute args**: `substituteArgs(body, args)` replaces `$1`, `$ALL`, etc.
5. **Resolve references**: `resolveReferences(body)` inlines `@path` files.
6. **Enforce limits**: `limitSkillBody(body)` truncates if over 32K chars.
7. **Switch provider**: `createSkillProviderSwitcher()` switches provider if the skill specifies `model.provider`.
8. **Construct prompt**: The body becomes a user message.
   ```
   [Skill: docker-ops activated]

   {skill body with substituted args}

   User request: build myapp:latest --no-cache
   ```
9. **Execute**: `runAgentLoop()` runs with the constructed prompt.
10. **Restore**: `switcher.restore()` returns the original provider.

### Path B: use\_skill tool (LLM-initiated)

When the AI decides to use a skill based on the catalog in its system prompt:

```
AI calls: use_skill({ skill_name: "docker-ops", args: { action: "build", image: "myapp:latest" } })
```

Step-by-step flow:

1. **Tool call received**: The `use_skill` tool handler receives `skill_name` and optional `args`.
2. **Lookup**: `registry.get(skill_name)` returns the skill metadata.
3. **Load body**: `registry.getBody(skill_name)` reads from disk, caches in LRU.
4. **Substitute args**: If `args` was provided, values are substituted into the body.
5. **Enforce limits**: `limitSkillBody(body)` truncates if over 32K chars.
6. **Return result**: Content is returned as a tool result string.

   ```
   # docker-ops Skill Activated

   {skill body with substituted args}

   ## Skill Arguments
   { "action": "build", "image": "myapp:latest" }
   ```

7. The AI receives the content in the next loop iteration and incorporates it into its response.

:::info
The `use_skill` tool path does **not** perform provider switching or `@path` resolution. It returns the skill content as-is for the AI to use. Provider switching only applies to the CLI slash command path where the full invocation pipeline is used.
:::

## Related APIs

- [generateText()](/sdk/generate-text) -- One-shot execution with skills
- [createAgent()](/sdk/create-agent) -- Stateful agent with skill support
- [Custom Tools](/sdk/custom-tools) -- Build custom tools
- [Types](/sdk/types) -- Full TypeScript type reference
