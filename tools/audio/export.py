"""Exports the 0 A.D. sounds and music the game uses (CC-BY-SA 3.0, Wildfire Games).

Sound effects are trimmed, faded and saved as mono Ogg Vorbis; music is
re-encoded at a lower bitrate to keep the download small.

Usage: python3 -I tools/audio/export.py <0ad audio dir> <output dir>
Requires: pip install soundfile numpy
"""
import os
import sys

import numpy as np
import soundfile as sf

SFX = {
    # name: (source, max seconds or None, gain)
    "sword_1": ("attack/weapon/swordhit_10.ogg", None, 0.9),
    "sword_2": ("attack/weapon/swordhit_11.ogg", None, 0.9),
    "sword_3": ("attack/weapon/swordhit_12.ogg", None, 0.9),
    "sword_4": ("attack/weapon/swordhit_13.ogg", None, 0.9),
    "sword_5": ("attack/weapon/swordhit_14.ogg", None, 0.9),
    "sword_6": ("attack/weapon/swordhit_15.ogg", None, 0.9),
    "spear_1": ("attack/weapon/spear_attack_01.ogg", 1.2, 0.9),
    "spear_2": ("attack/weapon/spear_attack_02.ogg", 1.2, 0.9),
    "spear_3": ("attack/weapon/spear_attack_03.ogg", 1.2, 0.9),
    "spear_4": ("attack/weapon/spear_attack_04.ogg", 1.2, 0.9),
    "bow_1": ("attack/weapon/bow_attack_01.ogg", 1.4, 0.8),
    "bow_2": ("attack/weapon/bow_attack_02.ogg", 1.4, 0.8),
    "bow_3": ("attack/weapon/bow_attack_03.ogg", 1.4, 0.8),
    "bow_4": ("attack/weapon/bow_attack_04.ogg", 1.4, 0.8),
    "arrow_hit_1": ("attack/impact/arrow_metal_01.ogg", None, 0.7),
    "arrow_hit_2": ("attack/impact/arrow_metal_02.ogg", None, 0.7),
    "arrow_hit_3": ("attack/impact/arrow_metal_03.ogg", None, 0.7),
    "arrow_miss_1": ("attack/impact/arrow_dirt_01.ogg", None, 0.6),
    "arrow_miss_2": ("attack/impact/arrow_dirt_02.ogg", None, 0.6),
    "arrow_miss_3": ("attack/impact/arrow_dirt_03.ogg", None, 0.6),
    "catapult_fire": ("attack/siege/onager_shooting_11.ogg", None, 1.0),
    "catapult_impact": ("attack/destruction/explode_debris_20.ogg", 2.2, 1.0),
    "death_1": ("actor/human/death/male_death_01.ogg", None, 0.8),
    "death_2": ("actor/human/death/male_death_04.ogg", None, 0.8),
    "death_3": ("actor/human/death/male_death_07.ogg", None, 0.8),
    "death_4": ("actor/human/death/male_death_10.ogg", None, 0.8),
    "death_5": ("actor/human/death/male_death_13.ogg", None, 0.8),
    "death_6": ("actor/human/death/male_death_16.ogg", None, 0.8),
    "death_7": ("actor/human/death/male_death_19.ogg", None, 0.8),
    "death_8": ("actor/human/death/male_death_22.ogg", None, 0.8),
    "horse_death_1": ("actor/mounted/death/death_horse_10.ogg", None, 0.8),
    "horse_death_2": ("actor/mounted/death/death_horse_11.ogg", None, 0.8),
    "gallop_1": ("actor/mounted/movement/mstep110.ogg", None, 0.6),
    "gallop_2": ("actor/mounted/movement/mstep112.ogg", None, 0.6),
    "siege_select": ("attack/siege/siege_select_10.ogg", None, 0.8),
    "victory": ("interface/alarm/alarmvictory_1.ogg", None, 0.9),
    "defeat": ("interface/alarm/alarmdefeat_1.ogg", None, 0.9),
    "horn": ("interface/alarm/alarmattackplayer_1.ogg", None, 0.8),
    "alert": ("interface/alarm/alarmalert1.ogg", None, 0.7),
    # Voices: the Legion answers in Latin, the Phalanx in Greek.
    "latin_select_1": ("voice/latin/civ/civ_male_my_lord_1.ogg", None, 1.0),
    "latin_select_2": ("voice/latin/civ/civ_male_what_is_it_1.ogg", None, 1.0),
    "latin_select_3": ("voice/latin/civ/civ_male_hello_1.ogg", None, 1.0),
    "latin_move_1": ("voice/latin/civ/civ_male_walk_1.ogg", None, 1.0),
    "latin_move_2": ("voice/latin/civ/civ_male_march_1.ogg", None, 1.0),
    "latin_attack_1": ("voice/latin/civ/civ_male_attack_1.ogg", None, 1.0),
    "latin_attack_2": ("voice/latin/civ/civ_male_fight_1.ogg", None, 1.0),
    "latin_attack_3": ("voice/latin/civ/civ_male_go_out_against_1.ogg", None, 1.0),
    "latin_regroup_1": ("voice/latin/civ/civ_male_gather_together_1.ogg", None, 1.0),
    "greek_select_1": ("voice/greek/civ/civ_male_yes_1.ogg", None, 1.0),
    "greek_move_1": ("voice/greek/civ/civ_male_Asyouwish_1.ogg", None, 1.0),
    "greek_move_2": ("voice/greek/civ/civ_male_Imcoming_1.ogg", None, 1.0),
    "greek_attack_1": ("voice/greek/civ/civ_male_attack_10.ogg", None, 1.0),
}

MUSIC = {
    "menu": "music/Calm_Before_the_Storm.ogg",
    "battle_1": "music/Red_Dawn.ogg",
    "battle_2": "music/Tale_of_Warriors.ogg",
}

AMBIENT = {"ambient_day": ("ambient/dayscape/day_temperate_gen_01.ogg", 60.0)}


def write_ogg(dst: str, data: np.ndarray, sr: int, quality: float) -> None:
    """Writes Ogg Vorbis in small blocks (single large writes crash libsndfile 1.2)."""
    channels = 1 if data.ndim == 1 else data.shape[1]
    with sf.SoundFile(dst, "w", sr, channels, format="OGG", subtype="VORBIS", compression_level=quality) as f:
        block = 8192
        for i in range(0, len(data), block):
            f.write(data[i : i + block])


def load_mono(path: str):
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    return data.mean(axis=1), sr


def fade(x: np.ndarray, sr: int, out_s: float = 0.08) -> np.ndarray:
    n = min(len(x), int(sr * out_s))
    if n > 0:
        x[-n:] *= np.linspace(1.0, 0.0, n, dtype=np.float32)
    return x


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(os.path.join(out, "sfx"), exist_ok=True)
    os.makedirs(os.path.join(out, "music"), exist_ok=True)
    total = 0
    for name, (rel, max_s, gain) in SFX.items():
        x, sr = load_mono(os.path.join(src, rel))
        if max_s:
            x = x[: int(sr * max_s)]
        x = fade(x * gain, sr, 0.25 if max_s else 0.02)
        dst = os.path.join(out, "sfx", f"{name}.ogg")
        write_ogg(dst, x, sr, 0.6)
        total += os.path.getsize(dst)
    for name, (rel, max_s) in AMBIENT.items():
        x, sr = load_mono(os.path.join(src, rel))
        x = x[: int(sr * max_s)]
        # Cross-fade the ends so the loop is seamless.
        n = int(sr * 2.0)
        head = x[:n].copy()
        x = x[n:]
        x[-n:] = x[-n:] * np.linspace(1, 0, n, dtype=np.float32) + head * np.linspace(0, 1, n, dtype=np.float32)
        dst = os.path.join(out, "music", f"{name}.ogg")
        write_ogg(dst, x * 0.8, sr, 0.8)
        total += os.path.getsize(dst)
    for name, rel in MUSIC.items():
        data, sr = sf.read(os.path.join(src, rel), dtype="float32", always_2d=True)
        dst = os.path.join(out, "music", f"{name}.ogg")
        write_ogg(dst, data, sr, 0.75)
        total += os.path.getsize(dst)
        print(name, os.path.getsize(dst) // 1024, "KB")
    print("total", total // 1024, "KB")


if __name__ == "__main__":
    main()
