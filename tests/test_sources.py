import json
import unittest
from datetime import datetime, timezone

from jobs.config import LEAGUES
from jobs.sources import (
    ApiFootballSource,
    CompositeSource,
    FootballDataCsvSource,
    FplSource,
    filter_upcoming_window,
)
from jobs.teams import canonical_team, display_team


class TestTeamMapping(unittest.TestCase):
    def test_known_provider_aliases(self):
        unmapped = set()
        self.assertEqual(canonical_team('Man Utd', unmapped), 'manchester united')
        self.assertEqual(canonical_team('Man United', unmapped), 'manchester united')
        self.assertEqual(canonical_team('Spurs', unmapped), 'tottenham')
        self.assertEqual(canonical_team("Nott'm Forest", unmapped), 'nott m forest')
        self.assertEqual(canonical_team('Nottingham Forest', unmapped), 'nott m forest')
        self.assertEqual(canonical_team('Coventry City', unmapped), 'coventry')
        self.assertEqual(canonical_team('Hull City', unmapped), 'hull')
        self.assertEqual(canonical_team('Ipswich Town', unmapped), 'ipswich')
        self.assertEqual(unmapped, set())

    def test_unmapped_team_is_reported(self):
        unmapped = set()
        self.assertEqual(canonical_team('Real Example FC', unmapped), 'real example fc')
        self.assertIn('Real Example FC', unmapped)
        self.assertEqual(display_team('nott m forest'), "Nott'm Forest")


class TestFplAndFallbacks(unittest.TestCase):
    def test_fpl_source_parses_upcoming_live_finished(self):
        bootstrap = {
            'teams': [
                {'id': 18, 'name': "Nott'm Forest"},
                {'id': 6, 'name': 'Chelsea'},
                {'id': 16, 'name': 'Man Utd'},
                {'id': 19, 'name': 'Spurs'},
            ]
        }
        fixtures = [
            {
                'id': 119,
                'kickoff_time': '2026-11-27T20:00:00Z',
                'team_h': 18,
                'team_a': 6,
                'started': False,
                'finished': False,
                'finished_provisional': False,
                'minutes': 0,
                'team_h_score': None,
                'team_a_score': None,
            },
            {
                'id': 103,
                'kickoff_time': '2026-11-23T20:00:00Z',
                'team_h': 16,
                'team_a': 19,
                'started': True,
                'finished': True,
                'finished_provisional': True,
                'minutes': 90,
                'team_h_score': 2,
                'team_a_score': 1,
            },
        ]

        def fake_get(url, headers=None):
            if 'bootstrap-static' in url:
                return 200, json.dumps(bootstrap).encode()
            return 200, json.dumps(fixtures).encode()

        res = FplSource(http_get=fake_get).fetch_season_fixtures(LEAGUES['E0'])
        self.assertEqual(res.source_used, 'fpl')
        self.assertEqual(res.unmapped_teams, set())
        self.assertEqual(len(res.fixtures), 2)
        self.assertEqual(res.fixtures[0].match_id, 'E0:2026:nott-m-forest:chelsea')
        self.assertEqual(res.fixtures[0].status, 'NS')
        self.assertEqual(res.fixtures[1].match_id, 'E0:2026:manchester-united:tottenham')
        self.assertEqual(res.fixtures[1].status, 'FT')
        self.assertEqual((res.fixtures[1].home_goals, res.fixtures[1].away_goals), (2, 1))

        now = datetime(2026, 11, 26, 12, 0, tzinfo=timezone.utc)
        up_36 = filter_upcoming_window(res.fixtures, now, 36)
        self.assertEqual(len(up_36), 1)
        self.assertEqual(up_36[0].provider_id, '119')

    def test_api_football_plan_error_raises_and_composite_falls_back(self):
        def failing_apifb(url, headers=None):
            return 200, json.dumps({
                'errors': {'plan': 'Free plans do not have access to this season'},
                'response': [],
            }).encode()

        csv_body = (
            "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG\n"
            "E0,22/11/2026,16:30,Liverpool,Man United,4,0\n"
        ).encode()

        def csv_get(url, headers=None):
            if 'fixtures.csv' in url:
                return 200, b"Div,Date,Time,HomeTeam,AwayTeam\nE0,27/11/2026,20:00,Nott'm Forest,Chelsea\n"
            return 200, csv_body

        comp = CompositeSource([
            ApiFootballSource('dummy', http_get=failing_apifb),
            FootballDataCsvSource(http_get=csv_get),
        ])
        res = comp.fetch_season_fixtures(LEAGUES['E0'])
        self.assertEqual(res.source_used, 'football_data_csv')
        self.assertEqual(len(res.errors), 1)
        self.assertEqual(len(res.fixtures), 2)


if __name__ == '__main__':
    unittest.main()
