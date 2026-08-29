"""Автогенерация англоязычных названий команд в научно-образовательной тематике."""
from __future__ import annotations

import random

PREFIXES = [
    "Cyber", "Quantum", "Tech", "Logic", "Future", "Nano", "Astro", "Neuro",
    "Bio", "Data", "Robo", "Eco", "Atomic", "Digital", "Solar", "Crypto",
    "Genome", "Photon", "Turbo", "Hyper", "Meta", "Alpha", "Delta", "Orbit",
    "Fusion", "Vector", "Prime", "Smart", "Stellar", "Chrono", "Plasma",
    "Kinetic", "Binary", "Cosmo", "Micro", "Poly", "Terra", "Aero", "Optic",
    "Synth",
]

SUFFIXES = [
    "Thinkers", "Explorers", "Pioneers", "Masters", "Lab", "Minds", "Coders",
    "Engineers", "Scientists", "Innovators", "Researchers", "Builders",
    "Analysts", "Architects", "Creators", "Hackers", "Navigators", "Seekers",
    "Discoverers", "Inventors", "Scholars", "Squad", "Crew", "Team",
    "Academy", "Circuit", "Matrix", "Nexus", "Vision", "Force", "Wave",
    "Sparks", "Titans", "Legends", "Dynamics", "Systems", "Genius", "Society",
    "Council", "Union",
]

# Гарантированно красивые эталонные названия — используются первыми.
CURATED = [
    "CyberThinkers", "QuantumExplorers", "TechPioneers", "LogicMasters",
    "FutureLab", "NanoEngineers", "AstroNavigators", "NeuroMinds",
    "BioInnovators", "DataArchitects", "RoboCreators", "EcoResearchers",
    "AtomicScholars", "DigitalVisionaries", "SolarDynamics", "CryptoCoders",
    "GenomeSeekers", "PhotonSquad", "FusionTitans", "VectorAnalysts",
]


def generate_team_names(count: int, seed: int = 2026) -> list[str]:
    """Вернуть `count` уникальных названий команд на английском языке."""
    rng = random.Random(seed)
    names: list[str] = []
    used: set[str] = set()

    for name in CURATED:
        if len(names) >= count:
            break
        names.append(name)
        used.add(name)

    combos = [f"{p}{s}" for p in PREFIXES for s in SUFFIXES if f"{p}{s}" not in used]
    rng.shuffle(combos)

    for name in combos:
        if len(names) >= count:
            break
        if name in used:
            continue
        names.append(name)
        used.add(name)

    index = 1
    while len(names) < count:
        candidate = f"ScienceUnit{index:02d}"
        if candidate not in used:
            names.append(candidate)
            used.add(candidate)
        index += 1

    return names[:count]
