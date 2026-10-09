# Art credits

All unit, scenery and terrain artwork in `public/assets/` is derived from
**0 A.D.** by **Wildfire Games** (https://www.wildfiregames.com/),
licensed under the **Creative Commons Attribution-ShareAlike 3.0** license
(https://creativecommons.org/licenses/by-sa/3.0/).

- `sprites/*` were rendered from 0 A.D.'s 3D models, textures and animations
  (actors from `binaries/data/mods/public/art/`) with `tools/sprites/`.
  Units: Roman hastatus, triarius, equites and onager; Macedonian/Seleucid
  thorakites, phalangite, cataphract and lithobolos; Cretan and Persian archers.
  Scenery: oak, Hungarian oak, elm, birch, maple and poplar trees, highland
  rocks, temperate bushes and grasses.
- `terrain/*` are downscaled 0 A.D. terrain textures (temperate grass, mud,
  forest floor; Aegean rocks, sand and paving). Some 0 A.D. textures are
  derived from CGTextures materials, distributed as CC-BY-SA with permission.

These derived files are distributed under the same CC-BY-SA 3.0 license.
Changes made: rendering to isometric sprite sheets, team-colour mask
extraction, resizing and re-encoding.

The game's source code (everything outside `public/assets/`) is separate from
these assets; see the repository README for its license.
