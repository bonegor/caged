"""Convert a DDS texture (DXT1/3/5 or uncompressed) to PNG, keeping alpha.

Usage: python3 -I dds2png.py input.dds output.png
"""
import sys

from PIL import Image


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    with Image.open(src) as im:
        im.load()
        im.convert("RGBA").save(dst)


if __name__ == "__main__":
    main()
