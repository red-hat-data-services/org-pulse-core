"""HTTP client for the Org Pulse Express API.

Tools call this client to fetch roster, metrics, and contribution data
from the main Express backend.
"""

import logging

from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)


class OrgPulseClient:
    def __init__(
        self,
        base_url: str = "http://localhost:3001",
        api_token: str | None = None,
        oauth_cookie: str | None = None,
    ):
        self._base_url = base_url.rstrip("/")
        headers = {}
        cookies = {}
        if api_token:
            headers["Authorization"] = f"Bearer {api_token}"
        if oauth_cookie:
            cookies["_oauth_proxy"] = oauth_cookie
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=30,
            follow_redirects=True,
            headers=headers,
            cookies=cookies,
        )
        self._cache: dict = {}

    def clear_cache(self):
        self._cache = {}

    async def close(self):
        await self._client.aclose()

    async def _get(self, path: str, params: dict | None = None, extra_headers: dict | None = None) -> dict | list | None:
        try:
            resp = await self._client.get(path, params=params, headers=extra_headers)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as exc:
            logger.warning("API %s returned %d: %s", path, exc.response.status_code, exc.response.text[:200])
            return None
        except httpx.RequestError as exc:
            logger.error("API request failed for %s: %s", path, exc)
            return None

    async def get_roster(self) -> dict | None:
        if "roster" in self._cache:
            return self._cache["roster"]
        data = await self._get("/api/modules/team-tracker/roster")
        if data is not None:
            self._cache["roster"] = data
        return data

    async def get_teams(self) -> list | None:
        return await self._get("/api/modules/team-tracker/structure/teams")

    async def get_person_metrics(self, name: str) -> dict | None:
        return await self._get(f"/api/modules/team-tracker/person/{quote(name, safe='')}/metrics")

    async def get_snapshots(self, team_key: str) -> list | None:
        return await self._get(f"/api/modules/team-tracker/snapshots/{quote(team_key, safe='')}")

    async def get_github_contributions(self) -> dict | None:
        return await self._get("/api/modules/team-tracker/github/contributions")

    async def get_gitlab_contributions(self) -> dict | None:
        return await self._get("/api/modules/team-tracker/gitlab/contributions")


class PerRequestClient(OrgPulseClient):
    """Wrapper that adds per-request auth headers to a shared OrgPulseClient.

    Inherits all data-fetching methods from OrgPulseClient so new methods are
    automatically available. Overrides _get() to inject X-Proxy-Secret and
    X-Forwarded-Email via the shared client's connection pool. Maintains its
    own independent cache so concurrent requests with different user identities
    don't cross-contaminate.
    """

    def __init__(self, shared_client: OrgPulseClient, proxy_secret: str, user_email: str):
        # Skip OrgPulseClient.__init__ — we don't create our own httpx client
        self._shared = shared_client
        self._extra_headers = {
            "X-Proxy-Secret": proxy_secret,
            "X-Forwarded-Email": user_email,
        }
        self._cache: dict = {}

    async def _get(self, path: str, params: dict | None = None, extra_headers: dict | None = None) -> dict | list | None:
        # Always use our per-request auth headers, ignore any passed extra_headers
        return await self._shared._get(path, params=params, extra_headers=self._extra_headers)

    async def close(self):
        # No-op — the shared client owns the connection pool
        pass
