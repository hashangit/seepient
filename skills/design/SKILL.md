---
name: design
description: >
  Single entry point for ALL design work in Seepient. Activates whenever the user
  asks to design, mock, prototype, style, brand, lay out, illustrate, generate or
  edit images, build slides/decks/presentations, create video/motion/animation,
  produce design systems or Figma work, review or critique design, write design
  copy, pick colors/typography/themes, or improve the visual quality of any
  artifact (web, desktop, mobile, print, social). Triggers on "design", "mockup",
  "prototype", "UI", "UX", "wireframe", "brand", "logo", "poster", "slide",
  "deck", "presentation", "infographic", "illustration", "icon", "color scheme",
  "typography", "design system", "redesign", "polish the UI", "make it look
  better", "Figma", "design review", "creative direction", and any visual or
  aesthetic request. This skill does NOT do the design itself — it routes the
  agent to the right upstream skill in the OpenDesign catalogue and applies that
  skill's procedure.
version: 1.0.0
author: Seepient
tags:
  - design
  - ui
  - ux
  - brand
  - visual
  - frontend
  - slides
  - image-generation
  - motion
  - routing
allowedTools:
  - read_website
  - web_search
  - read_file
  - write_file
  - generate_image
  - take_screenshot
  - execute_shell_command
---

# Design

You are doing design work. Seepient ships no design procedures of its own —
design expertise lives in the upstream **OpenDesign** catalogue and you pull the
right skill in on demand. This keeps one source of truth and no drift.

Do the following every time. Do not skip steps. Do not improvise your own design
procedure.

## 1. Classify the request

Match the request to exactly one upstream skill in the routing table below. Pick
the single most specific skill. If several apply, choose the most specific and
keep the others as supporting references.

## 2. Fetch the upstream skill

Fetch the full `SKILL.md` for the slug you chose from the raw URL, using
`read_website`:

```
https://raw.githubusercontent.com/nexu-io/open-design/main/skills/<slug>/SKILL.md
```

Read it completely before doing anything. Its steps, constraints, and output
format are authoritative — follow them exactly.

If the fetch fails (404, network error), do not proceed on guesswork. Fall back
to the browse URL
`https://github.com/nexu-io/open-design/tree/main/skills/<slug>`, or search the
catalogue, and tell the user which skill you used.

## 3. Map upstream tools to Seepient tools

Upstream skills assume OpenDesign's toolset. Map each tool to Seepient's. **Never
silently drop a step because a tool is missing** — flag it and propose the
closest alternative.

| Upstream need | Seepient tool |
|---|---|
| generate/edit images (`fal`, `venice`, `imagen`, `sora`) | `generate_image`; or `read_website` to call a hosted API |
| fetch a reference page or screenshot | `read_website`, `take_screenshot` |
| read/write design files & assets | `read_file`, `write_file` |
| search for inspiration / examples | `web_search` |
| live Figma MCP / device preview | no equivalent — flag it; propose static export or `take_screenshot` |

## 4. Follow the upstream procedure end-to-end

Execute the upstream skill's procedure in full, with Seepient's quality bar
applied on top (below).

## 5. If nothing in the table fits

Browse the full catalogue, pick the best match, and proceed the same way. State
which upstream skill you used.

> Catalogue (browse to discover/confirm): https://github.com/nexu-io/open-design/tree/main/skills

## Routing table

Each `<slug>` resolves to
`https://raw.githubusercontent.com/nexu-io/open-design/main/skills/<slug>/SKILL.md`.

### Design process, briefs & review
Plan, scope, critique, or improve design work.
- `design-brief` — write/structure a design brief
- `design-review` — critique a design against its goals
- `plan-design-review` — plan a design review session
- `design-consultation` — advisory design dialogue
- `redesign-skill` — systematic redesign of an existing artifact
- `impeccable-design-polish` — final polish pass
- `design-md` — maintain a `DESIGN.md` source of truth (tokens, direction, rules)
- `reference-design-contract` — pin design references/contracts
- `brainstorming` — structured idea generation
- `creative-director` — creative direction + recursive self-assessment
- `research-decision-room` — research-driven design decisions
- `enhance-prompt` — sharpen a design prompt before generating
- `pr-feedback-quality-gate` — quality gate before shipping

### Taste & aesthetic direction
Set the visual/aesthetic bar and style.
- `taste-skill`, `taste-skill-v1`, `gpt-tasteskill` — taste/judgement
- `minimalist-skill`, `brutalist-skill`, `soft-skill` — named aesthetic modes
- `swiss-creative-mode-template` — Swiss / International style
- `ui-ux-pro-max`, `ui-skills`, `frontend-skill`, `platform-design`, `output-skill`
- `library-curator` — curate a component/pattern library

### Brand & visual identity
- `brand-guidelines`, `brand-extract`, `brandkit`
- `color-expert` — color theory and palettes
- `theme-factory` — generate design themes/tokens
- `ad-creative`, `competitive-ads-extractor`
- `domain-name-brainstormer`

### Frontend / web UI / design-to-code
- `frontend-design` — distinctive, production-grade frontend
- `frontend-dev` — implement frontend code
- `shadcn-ui` — shadcn/ui components
- `image-to-code-skill` — design image → code
- `web-design-guidelines` — web design rules
- `login-flow`, `faq-page`, `paywall-upgrade-cro`
- `artifacts-builder`, `web-artifacts-builder`
- `mockup-device-3d`, `screenshot`, `full-page-screenshot`, `screenshots-marketing`

### Design systems & Figma
- `figma-create-design-system-rules`, `figma-generate-design`, `figma-generate-library`
- `figma-create-new-file`, `figma-implement-design`, `figma-code-connect-components`, `figma-use`
- `wpds` — design system patterns

### Native platforms (Apple / mobile)
- `apple-hig` — Apple Human Interface Guidelines
- `swiftui-design`, `flutter-animating-apps`
- `imagegen-frontend-mobile`, `imagegen-frontend-web`

### Slides, decks & presentations
- `slides`, `frontend-slides`
- `pptx`, `pptx-generator`, `pptx-html-fidelity-audit`, `ppt-keynote`
- `nanobanana-ppt`, `html-ppt-retro-quarterly-review`
- `deck-swiss-international`, `deck-open-slide-canvas`, `deck-guizang-editorial`
- `release-notes-one-pager`, `resume-modern`

### Image generation & editing
- `imagegen` (OpenAI), `imagen` (Gemini)
- `image-enhancer`, `ecommerce-image-workflow`, `poster-hero`
- `fal-generate`, `fal-image-edit`, `fal-upscale`, `fal-restore`, `fal-tryon`, `fal-3d`
- `venice-image-generate`, `venice-image-edit`, `replicate`, `pixelbin-media`

### Social & marketing cards
- `card-twitter`, `card-xiaohongshu`, `social-reddit-card`, `social-spotify-card`, `social-x-post-card`
- `slack-gif-creator`, `gif-sticker-maker`

### Video, motion & animation
- `video-hyperframes`, `sora`, `remotion`, `venice-video`
- `minimax-docx`, `minimax-pdf`, `video-downloader`, `youtube-clipper`
- `emilkowalski-motion`, `vfx-text-cursor`
- `frame-*` — `frame-data-chart-nyt`, `frame-flowchart-sticky`, `frame-glitch-title`, `frame-light-leak-cinema`, `frame-liquid-bg-hero`, `frame-logo-outro`, `frame-macos-notification`
- video templates — `8-bit-orbit-video-template`, `swiss-user-research-video-template`, `weread-year-in-review-video-template`, `ai-music-album`

### Web animation (GSAP / Three.js / shaders / data viz)
- GSAP — `gsap-core`, `gsap-scrolltrigger`, `gsap-react`, `gsap-timeline`, `gsap-frameworks`, `gsap-plugins`, `gsap-performance`, `gsap-utils`
- `threejs`, `shader-dev`, `d3-visualization`, `algorithmic-art`, `hand-drawn-diagrams`

### Documents & editorial (PDF / DOCX / templates)
- `docx`, `pdf`, `doc`, `doc-kami-parchment`
- `article-magazine`, `data-report`, `copywriting`, `marketing-psychology`
- editorial templates — `field-notes-editorial-template`, `editorial-burgundy-principles-template`, `after-hours-editorial-template`, `digits-fintech-swiss-template`, `canvas-design`

### Audio / speech
- `speech`, `venice-audio-music`, `venice-audio-speech`

## Quality bar (apply on top of the upstream skill)

- **Name the upstream skill** at the start of your work, e.g. *"Following
  `frontend-design` from OpenDesign."*
- **Adapt, don't assume.** Map upstream tools to Seepient tools explicitly (table
  above). Never silently skip a step because a tool is missing — flag it.
- **Confirm external calls.** Generating images, calling hosted APIs, or fetching
  live pages sends data externally. Confirm with the user on the first such call
  unless they have already authorized it.
- **Prefer real files.** When the output is code/markup, write it to a file with
  `write_file`; when it is an image, save it and reference the path.
- **If the catalogue moved or a slug 404s**, browse the master catalogue link,
  pick the nearest match, and tell the user you adapted.
