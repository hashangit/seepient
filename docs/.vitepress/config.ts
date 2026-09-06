import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Seepient',
  description: 'An autonomous AI agent species: TUI, CLI, SDK, and server over one runtime',
  base: '/',
  appearance: false,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }]
  ],

  markdown: {
    theme: { light: 'vesper', dark: 'vesper' }
  },

  themeConfig: {
    nav: [
      { text: 'Guides', link: '/guides/introduction', activeMatch: '^/guides/' },
      {
        text: 'Surfaces',
        items: [
          { text: 'Terminal UI (TUI)', link: '/tui/overview' },
          { text: 'Command Line (CLI)', link: '/cli/overview' },
          { text: 'TypeScript SDK', link: '/sdk/overview' },
          { text: 'Server & Protocol', link: '/server/overview' }
        ]
      },
      {
        text: 'Tools',
        items: [
          { text: 'Built-in Tools Reference', link: '/tools/reference' },
          { text: 'Tools and Effects Guide', link: '/guides/tools-and-effects' },
          { text: 'Custom Tools (SDK)', link: '/sdk/custom-tools' },
          { text: 'MCP Gateway', link: '/sdk/mcp-gateway' },
          { text: 'Interactive TUI Widgets', link: '/tui/widgets' }
        ]
      },
      {
        text: 'Reference',
        items: [
          {
            text: 'Tools & APIs',
            items: [
              { text: 'Built-in Tools Reference', link: '/tools/reference' },
              { text: 'SDK Types & Contracts', link: '/sdk/types' },
              { text: 'CLI Command Reference', link: '/cli/reference' },
              { text: 'REST API Reference', link: '/server/rest-api' },
              { text: 'WebSocket Protocol', link: '/server/websocket-api' }
            ]
          },
          {
            text: 'Security & Governance',
            items: [
              { text: 'Security Review Package (008)', link: '/security-review-008' },
              { text: 'Audit Trail Contract', link: '/security/audit' }
            ]
          }
        ]
      },
      {
        text: 'Architecture',
        items: [
          { text: 'System Architecture', link: '/architecture/how-seepient-works' },
          { text: 'Execution Lifecycle', link: '/architecture/execution-lifecycle' },
          { text: 'Security & Sandbox', link: '/security/overview' }
        ]
      },
      { text: 'Cookbook', link: '/cookbook/overview', activeMatch: '^/cookbook/' },
      { text: 'Articles', link: '/articles/01-engineering-an-ai-person', activeMatch: '^/articles/' }
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
            { text: 'Sessions and state', link: '/guides/sessions-and-state' },
            { text: 'Built-in tools reference', link: '/tools/reference' }
          ]
        }
      ],

      '/architecture/': [
        {
          text: 'System architecture',
          items: [
            { text: 'How Seepient works', link: '/architecture/how-seepient-works' },
            { text: 'Execution lifecycle', link: '/architecture/execution-lifecycle' },
            { text: 'Security review package (008)', link: '/security-review-008' }
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
            { text: 'askSeepient', link: '/sdk/ask-seepient' },
            { text: 'Settings', link: '/sdk/settings' },
            { text: 'Provider management', link: '/sdk/provider-management' },
            { text: 'Custom tools', link: '/sdk/custom-tools' },
            { text: 'MCP Gateway', link: '/sdk/mcp-gateway' },
            { text: 'Built-in tools reference', link: '/tools/reference' },
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

      '/tools/': [
        {
          text: 'Tools and capabilities',
          items: [
            { text: 'Built-in tools reference', link: '/tools/reference' },
            { text: 'Tools and effects guide', link: '/guides/tools-and-effects' },
            { text: 'Custom tools (SDK)', link: '/sdk/custom-tools' },
            { text: 'MCP Gateway', link: '/sdk/mcp-gateway' },
            { text: 'Interactive TUI widgets', link: '/tui/widgets' }
          ]
        },
        {
          text: 'Reference links',
          items: [
            { text: 'SDK types and contracts', link: '/sdk/types' },
            { text: 'CLI command reference', link: '/cli/reference' },
            { text: 'Server REST API', link: '/server/rest-api' }
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
            { text: 'Audit trail', link: '/security/audit' },
            { text: 'Security review package (008)', link: '/security-review-008' }
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
      ],

      '/articles/': [
        {
          text: 'Engineering Deep Dives',
          items: [
            { text: 'Engineering an AI person', link: '/articles/01-engineering-an-ai-person' },
            { text: 'Foundational architecture', link: '/articles/02a-foundational-architecture' },
            { text: 'Enforcing architecture vs AI slop', link: '/articles/02b-enforcing-architecture-ai-slop' },
            { text: 'Permission system deep dive', link: '/articles/03-permission-system-deep-dive' }
          ]
        }
      ],

      '/embedding/': [
        {
          text: 'Stateless embedding',
          items: [
            { text: 'Stateless workers', link: '/sdk/stateless-workers' },
            { text: 'Session persistence', link: '/sdk/session-persistence' }
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

  srcExclude: ['superpowers/**']
})
