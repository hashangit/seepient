export type VsPoints = {
  seepients: readonly string[];
  other: readonly string[];
};

/**
 * Short card lines. Each one is a compression of the comparison already on that
 * page, not a new claim.
 */
export const VS_CARDS: Record<string, VsPoints> = {
  "muse-alternative": {
    seepients: ["You host it", "You bring the model", "Apache-2.0"],
    other: ["Meta hosts it", "Muse Spark", "Muse app and WhatsApp"],
  },
  "dots-alternative": {
    seepients: ["You host it", "Any supported model", "Apache-2.0"],
    other: ["OpenAI hosts it", "Eligible ChatGPT plans", "Not open source"],
  },
  "grok-bot-alternative": {
    seepients: ["You host it", "You bring the model", "Apache-2.0"],
    other: ["xAI hosts it", "Paid Cursor and SuperGrok", "No source to run"],
  },
  "openclaw-alternative": {
    seepients: ["Chat in the Seepients app", "Docker installer, then chat", "Apache-2.0"],
    other: ["Gateway for chat apps", "CLI, onboarding, config file", "MIT"],
  },
  "hermes-alternative": {
    seepients: ["Chat in the Seepients app", "Docker installer, then chat", "Apache-2.0"],
    other: ["Desktop app and a CLI", "Config under ~/.hermes", "MIT"],
  },
  "instinct-alternative": {
    seepients: ["You host it", "You bring the model", "Apache-2.0"],
    other: ["Hosted assistant", "Text or call", "Not self-hosted"],
  },
  "hark-alternative": {
    seepients: ["You host it", "You bring the model", "Apache-2.0"],
    other: ["Hark hosts it", "Free, with paid usage tiers", "Not self-hosted"],
  },
};

export function vsCard(slug: string): VsPoints | undefined {
  return VS_CARDS[slug];
}
