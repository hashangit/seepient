import { createContext, useContext, type ReactNode } from 'react';
import { theme, type Theme } from '../theme.js';

const ThemeContext = createContext<Theme>(theme);

/** Provides the theme to all descendants. Wrap the TUI root once. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

/** Access the active theme. Single source of color tokens in components. */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}
