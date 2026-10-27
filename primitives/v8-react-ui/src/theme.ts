import type { CSSProperties } from 'react';

/** Inherited CSS variables are equally supported; no document/root mutation. */
export type ChatThemeTokens = Readonly<{
  canvas: string; surface: string; raised: string; hover: string; border: string;
  text: string; secondary: string; muted: string; accent: string; accentInk: string;
  success: string; waiting: string; error: string; font: string; mono: string;
}>;
export const darkChatTheme: ChatThemeTokens = Object.freeze({
  canvas: '#141615', surface: '#202321', raised: '#282c29', hover: '#303631', border: '#343a35',
  text: '#eff1eb', secondary: '#b6bdb3', muted: '#929b90', accent: '#a4c5ad', accentInk: '#17241b',
  success: '#9ac4a5', waiting: '#e6ad52', error: '#f5838c', font: 'ui-sans-serif, system-ui, sans-serif', mono: 'ui-monospace, monospace',
});
export const lightChatTheme: ChatThemeTokens = Object.freeze({
  canvas: '#f7f8f5', surface: '#ffffff', raised: '#eef1eb', hover: '#e5eae2', border: '#ccd4c8',
  text: '#1e271f', secondary: '#4a594b', muted: '#607060', accent: '#356447', accentInk: '#ffffff',
  success: '#27633c', waiting: '#795600', error: '#a52c38', font: darkChatTheme.font, mono: darkChatTheme.mono,
});
export function chatThemeStyle(theme: Partial<ChatThemeTokens> = {}): CSSProperties {
  return Object.fromEntries(Object.entries(theme).map(([key, value]) => [`--mpx-chat-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value])) as CSSProperties;
}
