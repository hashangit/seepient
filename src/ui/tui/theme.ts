/**
 * Tokyo Night Moon — color palette for the Seepient TUI.
 *
 * US1 imports these tokens directly (`import { theme } from '../theme.js'`);
 * US3 wraps them in a React context via `use-theme.ts` so components can be
 * re-themed without touching call sites. Hex values are the single source of
 * truth for every component color — no inline hex elsewhere.
 */

export interface Theme {
  bg: string;
  bgHighlight: string;
  fg: string;
  fgDim: string;
  fgGutter: string;
  blue: string;
  cyan: string;
  green: string;
  yellow: string;
  red: string;
  purple: string;
  orange: string;
}

export const theme: Theme = {
  bg: '#222436',
  bgHighlight: '#2f334d',
  fg: '#c8d3f5',
  fgDim: '#828bb8',
  fgGutter: '#3b4261',
  blue: '#82aaff',
  cyan: '#86e1fc',
  green: '#c3e88d',
  yellow: '#ffc777',
  red: '#ff757f',
  purple: '#c099ff',
  orange: '#ff966c',
};
