// Track accent palette — shared by WorkstationShell (new-track assignment) and
// ContextMenu (the Color submenu swatches). Lives in its own module because a
// direct Shell → ContextMenu → Shell import would be circular.
export const TRACK_COLORS = [
  '#5DCAA5', // teal (brand accent)
  '#5A9FD4', // blue
  '#D4845A', // coral
  '#A57BD4', // purple
  '#D4C45A', // amber
  '#D45A7B', // rose
  '#7BD45A', // lime
];
