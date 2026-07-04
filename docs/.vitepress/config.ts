import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Seepient Agent',
  description: 'Headless AI agent framework with multi-provider LLM support',
  base: '/seepient/',
  appearance: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }]
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/getting-started/installation' },
      { text: 'SDK Reference', link: '/sdk/overview' },
      { text: 'Server API', link: '/server/overview' },
      { text: 'Guides', link: '/guides/build-your-own-ui' },
      {
        text: 'GitHub',
        link: 'https://github.com/hashangit/seepient'
      }
    ],

    sidebar: {
      '/getting-started/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Quick Start', link: '/getting-started/quick-start' },
            { text: 'Configuration', link: '/getting-started/configuration' }
          ]
        }
      ],
      '/sdk/': [
        {
          text: 'SDK Reference',
          items: [
            { text: 'Overview', link: '/sdk/overview' },
            { text: 'generateText', link: '/sdk/generate-text' },
            { text: 'streamText', link: '/sdk/stream-text' },
            { text: 'createAgent', link: '/sdk/create-agent' },
            { text: 'Custom Tools', link: '/sdk/custom-tools' },
            { text: 'Providers', link: '/sdk/providers' },
            { text: 'Skills', link: '/sdk/skills' },
            { text: 'Hooks', link: '/sdk/hooks' },
            { text: 'Structured Output', link: '/sdk/structured-output' },
            { text: 'Sessions', link: '/sdk/sessions' },
            { text: 'React Hook', link: '/sdk/react-hook' },
            { text: 'Types', link: '/sdk/types' }
          ]
        }
      ],
      '/server/': [
        {
          text: 'Server API',
          items: [
            { text: 'Overview', link: '/server/overview' },
            { text: 'REST API', link: '/server/rest-api' },
            { text: 'WebSocket API', link: '/server/websocket-api' },
            { text: 'Authentication', link: '/server/authentication' },
            { text: 'Sessions', link: '/server/sessions' },
            { text: 'Deployment', link: '/server/deployment' }
          ]
        }
      ],
      '/guides/': [
        {
          text: 'Guides',
          items: [
            { text: 'Build Your Own UI', link: '/guides/build-your-own-ui' },
            { text: 'Deploy as Backend', link: '/guides/deploy-as-backend' },
            { text: 'Custom Tools Guide', link: '/guides/custom-tools-guide' },
            { text: 'Custom Skills Guide', link: '/guides/custom-skills-guide' },
            { text: 'Production Checklist', link: '/guides/production-checklist' }
          ]
        }
      ],
      '/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Quick Start', link: '/getting-started/quick-start' },
            { text: 'Configuration', link: '/getting-started/configuration' }
          ]
        },
        {
          text: 'SDK Reference',
          items: [
            { text: 'Overview', link: '/sdk/overview' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/hashangit/seepient' }
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Seepient Agent contributors'
    },

    search: {
      provider: 'local'
    }
  },

  srcExclude: ['superpowers/**']
})
