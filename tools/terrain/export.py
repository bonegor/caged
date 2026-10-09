"""Exports the 0 A.D. terrain textures the game uses as 512x512 WebP tiles.

Usage: python3 -I tools/terrain/export.py <0ad art dir> <output dir>
The textures are CC-BY-SA 3.0 (c) Wildfire Games; see public/assets/CREDITS.md.
"""
import os
import sys

from PIL import Image

TEXTURES = {
    "grass": "temperate/grass_05.png",
    "grass_dry": "temperate/grass_03.png",
    "grass_mud": "temperate/grass_mud_01.png",
    "forest_floor": "temperate/forestfloor_003.png",
    "rocky": "aegean_anatolia/rocks_grass_01.png",
    "sand": "aegean_anatolia/sand_01_wet.png",
    "dirt": "temperate/mud_01.png",
    "paving": "aegean_anatolia/paving_01.png",
}


def main() -> None:
    art, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for name, rel in TEXTURES.items():
        src = os.path.join(art, "textures/terrain/types", rel)
        with Image.open(src) as im:
            im = im.convert("RGB").resize((512, 512), Image.LANCZOS)
            im.save(os.path.join(out, f"{name}.webp"), "WEBP", quality=86, method=6)
        print(name, os.path.getsize(os.path.join(out, f"{name}.webp")) // 1024, "KB")


if __name__ == "__main__":
    main()
