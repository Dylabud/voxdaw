// Three-theme system: 'dark' (charcoal default, bare :root), 'slate' (lighter
// dark mode for bright rooms), 'light'. Root.js owns the state and applies
// data-theme on its wrapper; every page's toggle button cycles THEME_ORDER and
// renders THEME_GLYPHS (fill = darkness: ● dark, ◑ slate, ○ light).
export const THEME_ORDER  = ['dark', 'slate', 'light'];
export const THEME_GLYPHS = { dark: '●', slate: '◑', light: '○' };
export const THEME_LABELS = { dark: 'dark', slate: 'slate (lighter dark)', light: 'light' };
export const nextTheme = (t) =>
  THEME_ORDER[(THEME_ORDER.indexOf(t) + 1) % THEME_ORDER.length];
