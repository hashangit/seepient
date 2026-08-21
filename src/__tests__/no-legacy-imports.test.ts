import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

function getAllTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...getAllTsFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("P8: No legacy provider imports or symbols regression guard", () => {
  const srcDir = path.resolve(__dirname, "..");
  const allFiles = getAllTsFiles(srcDir).filter(
    (file) =>
      !file.includes("__tests__") &&
      !file.endsWith(".test.ts") &&
      !file.endsWith(".test.tsx") &&
      !file.endsWith(".spec.ts"),
  );

  const bannedPatterns: { label: string; regex: RegExp }[] = [
    {
      label: "contracts/llm import",
      regex: /from\s+['"][^'"]*contracts\/llm(?:\.js)?['"]/,
    },
    {
      label: "capabilities/llm import",
      regex: /from\s+['"][^'"]*capabilities\/llm(?:\.js)?['"]/,
    },
    {
      label: "legacy domain/providers/provider-config import",
      regex: /from\s+['"][^'"]*domain\/providers\/provider-config(?:\.js)?['"]/,
    },
    {
      label: "legacy domain/providers/provider-env import",
      regex: /from\s+['"][^'"]*(?:domain\/providers\/provider-env|\/provider-env)(?:\.js)?['"]/,
    },
    {
      label: "legacy domain/providers/provider-resolver import",
      regex: /from\s+['"][^'"]*(?:domain\/providers\/provider-resolver|\/provider-resolver)(?:\.js)?['"]/,
    },
    {
      label: "legacy migration import",
      regex: /from\s+['"][^'"]*(?:domain\/providers\/migration|\/migration)(?:\.js)?['"]/,
    },
    {
      label: "legacy ProviderType type reference",
      regex: /\bProviderType\b/,
    },
    {
      label: "legacy DEFAULT_MODELS reference",
      regex: /\bDEFAULT_MODELS\b/,
    },
    {
      label: "legacy MODEL_CATALOG reference",
      regex: /\bMODEL_CATALOG\b/,
    },
    {
      label: "legacy getProvider( call",
      regex: /\bgetProvider\s*\(/,
    },
    {
      label: "legacy configureProviders( call",
      regex: /\bconfigureProviders\s*\(/,
    },
    {
      label: "legacy ALL_PROVIDER_TYPES reference",
      regex: /\bALL_PROVIDER_TYPES\b/,
    },
    {
      label: "legacy OpenAI Official string",
      regex: /['"]OpenAI Official['"]/,
    },
    {
      label: "legacy Anthropic Official string",
      regex: /['"]Anthropic Official['"]/,
    },
    {
      label: "legacy GLM Code Plan string",
      regex: /['"]GLM Code Plan['"]/,
    },
    {
      label: "legacy defaultModelMap reference",
      regex: /\bdefaultModelMap\b/,
    },
    {
      label: "legacy claude-3-7-sonnet-latest literal",
      regex: /['"]claude-3-7-sonnet-latest['"]/,
    },
    {
      label: "legacy glm-4-plus literal",
      regex: /['"]glm-4-plus['"]/,
    },
  ];

  it("ensures no production source file contains banned legacy imports or symbols", () => {
    const violations: { file: string; pattern: string; line: number; text: string }[] = [];

    for (const file of allFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { label, regex } of bannedPatterns) {
          if (regex.test(line)) {
            violations.push({
              file: path.relative(srcDir, file),
              pattern: label,
              line: i + 1,
              text: line.trim(),
            });
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
