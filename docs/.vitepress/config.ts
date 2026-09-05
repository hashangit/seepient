import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Seepient',
  description: 'An autonomous AI agent species: TUI, CLI, SDK, and server over one runtime',
  base: '/seepient/',
  appearance: false,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }]
  ],

  markdown: {
    theme: { light: 'vesper', dark: 'vesper' }
  },

  themeConfig: {
    nav: [
      { text: 'Guides', link: '/guides/introduction' },
      { text: 'Architecture', link: '/architecture/how-seepient-works' },
      { text: 'TUI', link: '/tui/overview' },
      { text: 'CLI', link: '/cli/overview' },
      { text: 'SDK', link: '/sdk/overview' },
      { text: 'Server', link: '/server/overview' },
      { text: 'Security', link: '/security/overview' },
      { text: 'Cookbook', link: '/cookbook/overview' }
    ],

    sidebar: {
      '/guides/': [
        {
          text: 'Getting started',
          items: [
            { text: 'Introduction', link: '/guides/introduction' },
            { text: 'Quick start', link: '/guides/quick-start' },
            { text: 'Installation', link: '/guides/installation' },
            { text: 'Configuration', link: '/guides/configuration' }
          ]
        },
        {
          text: 'Core concepts',
          items: [
            { text: 'Model routing', link: '/guides/model-routing' },
            { text: 'Skills system', link: '/guides/skills' },
            { text: 'Tools and effects', link: '/guides/tools-and-effects' },
            { text: 'Sessions and state', link: '/guides/sessions-and-state' }
          ]
        }
      ],

      '/architecture/': [
        {
          text: 'System architecture',
          items: [
            { text: 'How Seepient works', link: '/architecture/how-seepient-works' },
            { text: 'Execution lifecycle', link: '/architecture/execution-lifecycle' }
          ]
        }
      ],

      '/tui/': [
        {
          text: 'Terminal UI',
          items: [
            { text: 'Overview', link: '/tui/overview' },
            { text: 'Setup wizard', link: '/tui/setup-wizard' },
            { text: 'Interactive widgets', link: '/tui/widgets' },
            { text: 'Diffs and approvals', link: '/tui/diff-and-approvals' },
            { text: 'Slash commands', link: '/tui/commands' }
          ]
        }
      ],

      '/cli/': [
        {
          text: 'Command-line interface',
          items: [
            { text: 'Overview', link: '/cli/overview' },
            { text: 'Headless and piping', link: '/cli/headless-and-piping' },
            { text: 'Command reference', link: '/cli/reference' }
          ]
        }
      ],

      '/sdk/': [
        {
          text: 'TypeScript SDK',
          items: [
            { text: 'Overview', link: '/sdk/overview' },
            { text: 'createSeepient', link: '/sdk/create-seepient' },
            { text: 'generateText', link: '/sdk/generate-text' },
            { text: 'streamText', link: '/sdk/stream-text' },
            { text: 'Structured output', link: '/sdk/structured-output' },
            { text: 'Custom tools', link: '/sdk/custom-tools' },
            { text: 'Providers', link: '/sdk/providers' },
            { text: 'Skills', link: '/sdk/skills' },
            { text: 'Hooks and middleware', link: '/sdk/hooks' },
            { text: 'Session persistence', link: '/sdk/session-persistence' },
            { text: 'Stateless workers', link: '/sdk/stateless-workers' },
            { text: 'Types', link: '/sdk/types' }
          ]
        }
      ],

      '/server/': [
        {
          text: 'Server and protocol',
          items: [
            { text: 'Overview', link: '/server/overview' },
            { text: 'REST API', link: '/server/rest-api' },
            { text: 'WebSocket protocol', link: '/server/websocket-api' },
            { text: 'Authentication', link: '/server/authentication' },
            { text: 'Sessions', link: '/server/sessions' },
            { text: 'Worker scheduler', link: '/server/workers' },
            { text: 'Deployment', link: '/server/deployment' }
          ]
        }
      ],

      '/security/': [
        {
          text: 'Security and sandbox',
          items: [
            { text: 'Overview', link: '/security/overview' },
            { text: 'Permissions and consent', link: '/security/permissions' },
            { text: 'Process sandboxing', link: '/security/sandboxing' },
            { text: 'Exact commit protection', link: '/security/exact-commit' },
            { text: 'Audit trail', link: '/security/audit' }
          ]
        }
      ],

      '/cookbook/': [
        {
          text: 'Cookbook and recipes',
          items: [
            { text: 'Overview', link: '/cookbook/overview' },
            { text: 'GitHub Action PR reviewer', link: '/cookbook/github-action' },
            { text: 'React chat UI', link: '/cookbook/react-chat' },
            { text: 'Local LLMs with Ollama', link: '/cookbook/local-llm' },
            { text: 'Production checklist', link: '/cookbook/production-checklist' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/hashangit/seepient' }
    ],

    footer: {
      message: 'Released under the Business Source License 1.1.',
      copyright: 'Copyright © 2024-present Seepient contributors'
    },

    search: {
      provider: 'local'
    }
  },

  srcExclude: ['superpowers/**', 'articles/**']
})
