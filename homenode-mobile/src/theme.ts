/**
 * HomeNode's shared executive-tech palette.
 *
 * These values mirror the web application's CSS tokens so native and web
 * surfaces use the same purple, gold, neutral, and semantic colors.
 */
export const COLORS = Object.freeze({
  midnight: "#120d24",
  deepPurple: "#24143f",
  violet: "#6d28d9",
  violetHover: "#5521ae",
  violetBright: "#7c3aed",
  violetSoft: "#f2ecfc",
  gold: "#c6a15b",
  goldBright: "#d4b36f",
  goldHover: "#aa823e",
  goldInk: "#76561f",
  goldSoft: "#faf5e8",

  appBackground: "#f7f6fa",
  surface: "#ffffff",
  surfaceMuted: "#fbfaff",
  border: "#ded8e8",
  borderStrong: "#c9bfd8",
  divider: "#e9e3ef",
  text: "#171321",
  textPurple: "#33224f",
  muted: "#655e73",
  mutedSoft: "#7a7285",

  success: "#2f6b50",
  successSoft: "#e6f2eb",
  warning: "#805f19",
  warningSoft: "#fff4d8",
  danger: "#9d302a",
  dangerSoft: "#fbe8e5",
  disabled: "#e9e6ee",
  disabledText: "#625b6d",
  white: "#ffffff",
  shadow: "#120d24",
} as const);

export const HOME_NODE_THEME = Object.freeze({
  colors: COLORS,
  radius: Object.freeze({ small: 9, medium: 12, large: 16, pill: 22 }),
});
