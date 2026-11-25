"""Canonical team-name mapping across data providers and user nicknames."""
import re
import unicodedata

# Canonical keys MUST match footpred.data.team_name() output on football-data.co.uk CSVs.
PROVIDER_ALIASES: dict[str, str] = {
    'arsenal': 'arsenal',
    'arsenal fc': 'arsenal',
    'aston villa': 'aston villa',
    'aston villa fc': 'aston villa',
    'bournemouth': 'bournemouth',
    'afc bournemouth': 'bournemouth',
    'brentford': 'brentford',
    'brentford fc': 'brentford',
    'brighton': 'brighton',
    'brighton hove albion': 'brighton',
    'brighton and hove albion': 'brighton',
    'burnley': 'burnley',
    'burnley fc': 'burnley',
    'chelsea': 'chelsea',
    'chelsea fc': 'chelsea',
    'coventry': 'coventry',
    'coventry city': 'coventry',
    'crystal palace': 'crystal palace',
    'crystal palace fc': 'crystal palace',
    'everton': 'everton',
    'everton fc': 'everton',
    'fulham': 'fulham',
    'fulham fc': 'fulham',
    'hull': 'hull',
    'hull city': 'hull',
    'ipswich': 'ipswich',
    'ipswich town': 'ipswich',
    'leeds': 'leeds',
    'leeds united': 'leeds',
    'leicester': 'leicester',
    'leicester city': 'leicester',
    'liverpool': 'liverpool',
    'liverpool fc': 'liverpool',
    'luton': 'luton',
    'luton town': 'luton',
    'man city': 'manchester city',
    'manchester city': 'manchester city',
    'manchester city fc': 'manchester city',
    'man united': 'manchester united',
    'man utd': 'manchester united',
    'manchester utd': 'manchester united',
    'manchester united': 'manchester united',
    'manchester united fc': 'manchester united',
    'newcastle': 'newcastle',
    'newcastle united': 'newcastle',
    'newcastle utd': 'newcastle',
    'norwich': 'norwich',
    'norwich city': 'norwich',
    'nott m forest': 'nott m forest',
    'nottm forest': 'nott m forest',
    'nottingham forest': 'nott m forest',
    'sheffield united': 'sheffield united',
    'sheffield utd': 'sheffield united',
    'southampton': 'southampton',
    'spurs': 'tottenham',
    'sunderland': 'sunderland',
    'sunderland afc': 'sunderland',
    'tottenham': 'tottenham',
    'tottenham hotspur': 'tottenham',
    'watford': 'watford',
    'west brom': 'west brom',
    'west bromwich albion': 'west brom',
    'west ham': 'west ham',
    'west ham united': 'west ham',
    'wolves': 'wolves',
    'wolverhampton': 'wolves',
    'wolverhampton wanderers': 'wolves',
}

DISPLAY_NAMES: dict[str, str] = {
    'arsenal': 'Arsenal',
    'aston villa': 'Aston Villa',
    'bournemouth': 'Bournemouth',
    'brentford': 'Brentford',
    'brighton': 'Brighton',
    'burnley': 'Burnley',
    'chelsea': 'Chelsea',
    'coventry': 'Coventry',
    'crystal palace': 'Crystal Palace',
    'everton': 'Everton',
    'fulham': 'Fulham',
    'hull': 'Hull',
    'ipswich': 'Ipswich',
    'leeds': 'Leeds',
    'leicester': 'Leicester',
    'liverpool': 'Liverpool',
    'luton': 'Luton',
    'manchester city': 'Man City',
    'manchester united': 'Man Utd',
    'newcastle': 'Newcastle',
    'nott m forest': "Nott'm Forest",
    'sheffield united': 'Sheffield Utd',
    'southampton': 'Southampton',
    'sunderland': 'Sunderland',
    'tottenham': 'Tottenham',
    'west ham': 'West Ham',
    'wolves': 'Wolves',
}

USER_NICKNAMES: dict[str, list[str]] = {
    'arsenal': ['arsenal', 'ars', 'gunners'],
    'aston villa': ['aston villa', 'villa', 'avl'],
    'bournemouth': ['bournemouth', 'bou', 'cherries'],
    'brentford': ['brentford', 'bre', 'bees'],
    'brighton': ['brighton', 'bha', 'seagulls'],
    'chelsea': ['chelsea', 'che', 'blues'],
    'coventry': ['coventry', 'coventry city', 'cov', 'sky blues'],
    'crystal palace': ['crystal palace', 'palace', 'cry', 'eagles'],
    'everton': ['everton', 'eve', 'toffees'],
    'fulham': ['fulham', 'ful', 'cottagers'],
    'hull': ['hull', 'hull city', 'hul', 'tigers'],
    'ipswich': ['ipswich', 'ipswich town', 'ips', 'tractor boys'],
    'leeds': ['leeds', 'leeds united', 'lee'],
    'liverpool': ['liverpool', 'liv', 'lfc'],
    'manchester city': ['man city', 'manchester city', 'mci', 'mcfc', 'city'],
    'manchester united': ['man u', 'man utd', 'man united', 'manchester united', 'mun', 'mufc', 'united'],
    'newcastle': ['newcastle', 'newcastle united', 'new', 'nufc', 'toon', 'magpies'],
    'nott m forest': ['nottingham forest', "nott'm forest", 'nottm forest', 'forest', 'nfo'],
    'sunderland': ['sunderland', 'sun', 'black cats'],
    'tottenham': ['spurs', 'tottenham', 'tottenham hotspur', 'tot', 'thfc'],
}


def normalize_key(raw: str) -> str:
    s = unicodedata.normalize('NFKD', raw.casefold()).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


def canonical_team(raw: str, unmapped: set[str] | None = None) -> str:
    key = normalize_key(raw)
    if key in PROVIDER_ALIASES:
        return PROVIDER_ALIASES[key]
    if unmapped is not None and raw.strip():
        unmapped.add(raw.strip())
    return key


def display_team(canonical: str) -> str:
    return DISPLAY_NAMES.get(canonical, canonical.title())
