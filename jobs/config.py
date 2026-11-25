"""League configuration registry. Adding a league is a config addition here."""
from dataclasses import dataclass


@dataclass(frozen=True)
class LeagueConfig:
    code: str               # Internal / football-data.co.uk code, e.g. 'E0'
    name: str               # Display name
    api_football_id: int    # API-Football league id
    current_season: int     # Season start year, e.g. 2026 for 2026/27
    historical_seasons: tuple[int, ...]
    timezone: str
    fpl_enabled: bool = False
    fd_org_code: str | None = None


LEAGUES: dict[str, LeagueConfig] = {
    'E0': LeagueConfig(
        code='E0',
        name='Premier League',
        api_football_id=39,
        current_season=2026,
        historical_seasons=(2020, 2021, 2022, 2023, 2024, 2025),
        timezone='Africa/Lagos',
        fpl_enabled=True,
        fd_org_code='PL',
    ),
}

DEFAULT_LEAGUE = 'E0'
