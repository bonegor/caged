// Inline SVG icons for the command card.

const dots = (pts: [number, number][], r = 2.1) =>
  pts.map(([x, y]) => `<circle class="fill" cx="${x}" cy="${y}" r="${r}"/>`).join('');

const grid = (cols: number[], rows: number[]) => cols.flatMap((x) => rows.map((y) => [x, y] as [number, number]));

export const ICONS = {
  line: `<svg viewBox="0 0 30 26">${dots(grid([4, 10, 16, 22, 28].map((x) => x - 1), [8, 14]))}<path d="M3 21h24" stroke-width="1.2"/></svg>`,
  staggered: `<svg viewBox="0 0 30 26">${dots([
    [3, 7],
    [12, 7],
    [21, 7],
    [7.5, 14],
    [16.5, 14],
    [25.5, 14],
  ])}<path d="M3 21h24" stroke-width="1.2"/></svg>`,
  box: `<svg viewBox="0 0 30 26">${dots([
    [8, 4],
    [15, 4],
    [22, 4],
    [8, 12],
    [22, 12],
    [8, 20],
    [15, 20],
    [22, 20],
  ])}<circle cx="15" cy="12" r="2.4"/></svg>`,
  flank: `<svg viewBox="0 0 30 26">${dots(grid([3, 8], [8, 14]))}${dots(grid([22, 27], [8, 14]))}<path d="M3 21h7M20 21h7" stroke-width="1.2"/></svg>`,
  aggressive: `<svg viewBox="0 0 30 26"><path d="M7 21 21 7M17 6h5v5M9 15l2 2M5 23l3-3"/><path d="M22 21 8 7M12 6H7v5M20 15l-2 2M24 23l-3-3"/></svg>`,
  defensive: `<svg viewBox="0 0 30 26"><path d="M15 3 24 7v6c0 6-4 9.5-9 11-5-1.5-9-5-9-11V7z"/><path d="M15 8v11M10.5 12.5h9" stroke-width="1.4"/></svg>`,
  standGround: `<svg viewBox="0 0 30 26"><path d="M9 23V4"/><path class="fill" d="M9.8 4.5h13l-3.4 4 3.4 4h-13z"/><path d="M5 23h12"/></svg>`,
  noAttack: `<svg viewBox="0 0 30 26"><circle cx="15" cy="13" r="9"/><path d="M8.6 6.6 21.4 19.4"/></svg>`,
  attackMove: `<svg viewBox="0 0 30 26"><path d="M4 13h13M13 8l5 5-5 5"/><path d="M20 20 27 6M22 6h5v5" stroke-width="1.5"/></svg>`,
  stop: `<svg viewBox="0 0 30 26"><rect x="8" y="6" width="14" height="14" rx="1.5"/></svg>`,
  regroup: `<svg viewBox="0 0 30 26">${dots(grid([9, 15, 21], [9, 15]), 1.9)}<path d="M3 4l4 4M27 4l-4 4M3 22l4-4M27 22l-4-4"/></svg>`,
  pause: `<svg viewBox="0 0 30 26"><path d="M11 6v14M19 6v14" stroke-width="3"/></svg>`,
  play: `<svg viewBox="0 0 30 26"><path class="fill" d="M10 5l12 8-12 8z"/></svg>`,
};

export type IconName = keyof typeof ICONS;
