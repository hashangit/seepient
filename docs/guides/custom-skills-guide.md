---
title: Custom Skills Guide
description: Create, test, and package custom skills for Seepient Agent's skills system.
---

# Custom Skills Guide

Skills are reusable behavior packages that give Seepient Agent agents specialized knowledge and procedures. This guide covers creating custom skills from scratch.

## What Are Skills?

A skill is a Markdown file with YAML frontmatter that defines:

- **Metadata** -- name, description, tags, allowed tools
- **Content** -- instructions, context, and procedures the agent follows when the skill is active

Skills are activated at runtime via the `use_skill` tool. When a skill is activated, its content is injected into the agent's context, giving it specialized knowledge for that task.

## Skill File Format

Every skill is a directory containing a `SKILL.md` file:

```
my-skill/
  SKILL.md
```

The `SKILL.md` file has two sections:

```markdown
---
name: my-skill
description: What this skill does
tags:
  - tag1
  - tag2
allowedTools:
  - execute_shell_command
  - read_file
args:
  - environment
  - service
---

# Skill Content

Instructions for the agent go here. Use Markdown formatting.
```

The YAML frontmatter (between `---` delimiters) contains metadata. Everything after the second `---` is the skill body.

## Step 1: Create the Skill Directory Structure

Skills live in one of several locations, searched in priority order:

| Location | Priority | Use Case |
|---|---|---|
| `SEEPIENT_SKILLS_PATH` env var | Highest | Custom override path |
| `.seepient/skills/` in project root | High | Project-specific skills |
| `/mnt/skills/` | Medium | Docker volume-mounted skills |
| Bundled `skills/` directory | Lowest | Skills shipped with Seepient |

Create a project-level skill:

```bash
mkdir -p .seepient/skills/code-review
```

## Step 2: Write the Skill Frontmatter

Create `.seepient/skills/code-review/SKILL.md`:

```markdown
---
name: code-review
description: Review code for quality, security vulnerabilities, and best practices
version: 1.0.0
author: your-name
tags:
  - code
  - review
  - quality
  - security
allowedTools:
  - read_file
  - execute_shell_command
  - web_search
priority: 5
---
```

### Frontmatter Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Unique skill identifier (lowercase, hyphens) |
| `description` | `string` | Yes | Short description of what the skill does |
| `version` | `string` | No | Semantic version (default: `1.0.0`) |
| `author` | `string` | No | Author name or organization |
| `tags` | `string[]` | No | Tags for categorization and search |
| `allowedTools` | `string[]` | No | Restrict which tools the skill can use |
| `priority` | `number` | No | Higher priority wins when skills have the same name |
| `args` | `string[]` | No | Declared argument names for template substitution |
| `model` | `object` | No | Preferred model configuration for this skill |

### Model Configuration

Specify a preferred provider and model for the skill:

```yaml
model:
  provider: anthropic
  model: claude-sonnet-4-6-20260320
```

## Step 3: Write the Skill Content with @path References

The skill body is Markdown content injected into the agent's context when the skill is activated. Use `@path` references to inline file contents:

```markdown
---
name: api-docs-generator
description: Generate API documentation from route definitions
tags:
  - docs
  - api
args:
  - format
---

# API Documentation Generator

You are an API documentation specialist. Generate comprehensive documentation
for the API routes defined in the project.

## Process

1. Read the route definitions from the project
2. Identify all endpoints, their methods, parameters, and responses
3. Generate documentation in the requested format ($1)

## Reference Files

Route definitions are typically found in:
- @src/routes/index.ts
- @src/api/handlers/

## Output Format

$1 format should include:
- Endpoint path and HTTP method
- Request parameters with types
- Response schema
- Example requests and responses

## Style Guide

Refer to the project's documentation style:
- @docs/style-guide.md
```

### @path Reference Patterns

| Pattern | Resolves To |
|---|---|
| `@src/file.ts` | `{project_root}/src/file.ts` |
| `@seepient_documents/report.pdf` | `~/seepient_documents/report.pdf` |
| `@~/custom/path.txt` | `~/custom/path.txt` |

References are resolved relative to the project root (current working directory). Files must be under the project root, `~/seepient_documents/`, or `~/.seepient/` to be accessible. Files over 1 MB are skipped.

## Step 4: Test the Skill with use_skill

Test your skill using the CLI, SDK, or REST API.

### CLI

```bash
npx seepient chat
> /code-review Check the auth module for security issues
```

The `/` prefix triggers skill invocation. Arguments after the skill name are passed as positional parameters.

### SDK

```typescript
import { generateText } from "seepient";

const result = await generateText(
  "Review the authentication module for security issues",
  {
    tools: ["core", "use_skill"],
    skills: ["code-review"],
  }
);

console.log(result.text);
```

### REST API

```bash
curl -X POST http://localhost:7337/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Seepient-API-Key: sk_seepient_..." \
  -d '{
    "message": "Review the auth module",
    "skills": ["code-review"],
    "tools": ["core", "use_skill"]
  }'
```

### Verify Skill Loading

Check that your skill was discovered:

```bash
npx seepient skills list
```

Or via the API:

```bash
curl http://localhost:7337/v1/skills \
  -H "X-Seepient-API-Key: sk_seepient_..."
```

## Step 5: Package Skills for Reuse

### Sharing Skills

Skills are directories, so they can be shared via:

- **Git repository** -- clone into `.seepient/skills/`
- **npm package** -- install and point `SEEPIENT_SKILLS_PATH` to `node_modules/my-skills/`
- **Docker volume** -- mount at `/mnt/skills/`

### Environment Variable Configuration

Set `SEEPIENT_SKILLS_PATH` to one or more directories (colon-separated):

```bash
export SEEPIENT_SKILLS_PATH=/shared/skills:/opt/team-skills
```

### Docker Deployment

Mount your skills directory when running the container:

```bash
docker run -d \
  -p 7337:7337 \
  -v ./my-skills:/mnt/skills \
  --env-file .env \
  seepient-server
```

### Disable Bundled Skills

To only use custom skills:

```bash
export SEEPIENT_NO_BUNDLED_SKILLS=1
```

## Argument Substitution Patterns

Skills support template variables that are replaced with runtime arguments:

| Variable | Description | Example |
|---|---|---|
| `$1`, `$2`, ... | Positional arguments (1-indexed) | `$1` = `markdown` |
| `$ALL` | All arguments joined as a string | `markdown detailed` |
| `$FIRST` | First argument (same as `$1`) | `markdown` |
| `$LAST` | Last argument | `detailed` |
| `$COUNT` | Number of arguments | `2` |

### Example with Arguments

Skill file:

```markdown
---
name: deploy
description: Deploy a service to a specified environment
args:
  - service
  - environment
---

# Deploy $1 to $2

1. Run tests for $1
2. Build the Docker image for $1
3. Push to the $2 registry
4. Deploy to $2 Kubernetes namespace
5. Verify health check

Service: $1
Environment: $2
All args: $ALL
```

Invocation:

```bash
npx seepient chat
> /deploy my-api production
```

Resulting content injected into the agent:

```
# Deploy my-api to production

1. Run tests for my-api
2. Build the Docker image for my-api
3. Push to the production registry
4. Deploy to production Kubernetes namespace
5. Verify health check

Service: my-api
Environment: production
All args: my-api production
```

### Programmatic Arguments

Pass arguments via the `use_skill` tool:

```typescript
const result = await generateText("Deploy the service", {
  tools: ["use_skill"],
});

// The use_skill tool accepts args:
// { skill_name: "deploy", args: { service: "my-api", environment: "staging" } }
```

## Next Steps

- [Custom Tools Guide](/guides/custom-tools-guide) -- create tools that skills can invoke
- [Tools Reference](/tools/reference) -- complete reference for all built-in tools
- [Deploy as Backend](/guides/deploy-as-backend) -- deploy skills alongside your Seepient Agent server
