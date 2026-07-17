"""Tool functions for the Org Pulse chatbot agent.

Each tool calls the Org Pulse Express API via OrgPulseClient to fetch data.
All tools return JSON strings. Invalid inputs raise ModelRetry so the LLM
can self-correct.
"""

import asyncio
import contextvars
import json
import logging
import time
from functools import wraps
from typing import Optional

from pydantic_ai import RunContext
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.tools import Tool

from services.org_pulse_client import OrgPulseClient
from structured_logging import log_event

logger = logging.getLogger(__name__)

retry_events: contextvars.ContextVar[list | None] = contextvars.ContextVar(
    "retry_events", default=None
)


def _preview_args(kwargs):
    tool_args = {}
    for k, v in kwargs.items():
        if k == "ctx" or v is None:
            continue
        s = str(v)
        tool_args[k] = s[:200] if len(s) > 200 else v
    return tool_args


def _with_retry_tracking(fn):
    """Wrap a tool function to log execution, retries, and errors."""

    @wraps(fn)
    async def wrapper(*args, **kwargs):
        t0 = time.time()
        try:
            result = await fn(*args, **kwargs)
            duration_ms = round((time.time() - t0) * 1000, 1)
            log_event(logger, logging.DEBUG,
                      event="tool_executed", tool=fn.__name__,
                      duration_ms=duration_ms,
                      args_preview=_preview_args(kwargs))
            return result
        except ModelRetry as exc:
            duration_ms = round((time.time() - t0) * 1000, 1)
            preview = _preview_args(kwargs)
            events = retry_events.get(None)
            if events is not None:
                events.append(
                    {
                        "tool": fn.__name__,
                        "retry_message": str(exc),
                        "args_preview": preview,
                    }
                )
            log_event(logger, logging.WARNING,
                      event="tool_retry", tool=fn.__name__,
                      retry_message=str(exc),
                      duration_ms=duration_ms,
                      args_preview=preview)
            raise
        except Exception as exc:
            duration_ms = round((time.time() - t0) * 1000, 1)
            log_event(logger, logging.ERROR,
                      event="tool_error", tool=fn.__name__,
                      error_type=type(exc).__name__,
                      error_message=str(exc)[:300],
                      duration_ms=duration_ms,
                      args_preview=_preview_args(kwargs))
            raise

    return wrapper


def _match(value: str, query: str) -> bool:
    """Case-insensitive substring match."""
    return query.lower() in value.lower() if value and query else False


def _iter_people(roster: dict):
    """Yield (org_key, team_name, person) for every person in the roster."""
    for org in roster.get("orgs", []):
        org_key = org.get("key", "")
        leader = org.get("leader")
        teams = org.get("teams", {})
        if leader and leader.get("name"):
            yield org_key, None, leader
        for team_name, team_obj in teams.items():
            for member in team_obj.get("members", []):
                if member and member.get("name"):
                    yield org_key, team_name, member


# ---------------------------------------------------------------------------
# Roster / People
# ---------------------------------------------------------------------------


async def search_people(
    ctx: RunContext[OrgPulseClient],
    query: Optional[str] = None,
    team: Optional[str] = None,
    title: Optional[str] = None,
) -> str:
    """Search for people in the organization roster.

    Args:
        query: Search by name (partial match, case-insensitive).
        team: Filter by team name (partial match).
        title: Filter by job title (partial match).

    Returns at most 20 results. Use count_people for totals.

    Examples:
        "Who is John?" → search_people(query="John")
        "Who is on the Platform team?" → search_people(team="Platform")
        "Show me all senior engineers" → search_people(title="Senior")
    """
    roster = await ctx.deps.get_roster()
    if not roster:
        return json.dumps({"error": "Could not fetch roster data"})

    matches = []
    for org_key, team_name, person in _iter_people(roster):
        if query and not _match(person.get("name", ""), query):
            continue
        if team and not _match(team_name or "", team):
            continue
        if title and not _match(person.get("title", ""), title):
            continue

        matches.append(
            {
                "name": person.get("name"),
                "uid": person.get("uid"),
                "email": person.get("email"),
                "title": person.get("title"),
                "team": team_name,
                "github": person.get("githubUsername"),
                "gitlab": person.get("gitlabUsername"),
                "org": org_key,
            }
        )

    if not matches:
        filters = []
        if query:
            filters.append(f"name='{query}'")
        if team:
            filters.append(f"team='{team}'")
        if title:
            filters.append(f"title='{title}'")
        raise ModelRetry(
            f"No people found matching {', '.join(filters)}. "
            "Try a broader search or check the spelling."
        )

    return json.dumps(matches[:20], default=str)


async def get_person_details(ctx: RunContext[OrgPulseClient], uid: str) -> str:
    """Get full details for a specific person by their uid.

    Args:
        uid: The person's uid (e.g., 'jsmith'). Use search_people first to find valid UIDs.
    """
    roster = await ctx.deps.get_roster()
    if not roster:
        return json.dumps({"error": "Could not fetch roster data"})

    for org_key, team_name, person in _iter_people(roster):
        if person.get("uid") == uid:
            return json.dumps(
                {
                    "name": person.get("name"),
                    "uid": person.get("uid"),
                    "email": person.get("email"),
                    "title": person.get("title"),
                    "team": team_name,
                    "manager": person.get("manager"),
                    "github": person.get("githubUsername"),
                    "gitlab": person.get("gitlabUsername"),
                    "org": org_key,
                    "specialty": person.get("engineeringSpeciality"),
                },
                default=str,
            )

    raise ModelRetry(
        f"Person with uid '{uid}' not found. Use search_people to find valid UIDs."
    )


async def count_people(
    ctx: RunContext[OrgPulseClient],
    team: Optional[str] = None,
    title: Optional[str] = None,
) -> str:
    """Count people in the roster, optionally filtered by team or title.

    Args:
        team: Filter by team name (partial match).
        title: Filter by job title (partial match).

    Examples:
        "How many people are in the org?" → count_people()
        "How big is the Platform team?" → count_people(team="Platform")
    """
    roster = await ctx.deps.get_roster()
    if not roster:
        return json.dumps({"error": "Could not fetch roster data"})

    total = 0
    by_team: dict[str, int] = {}

    for _, team_name, person in _iter_people(roster):
        if team and not _match(team_name or "", team):
            continue
        if title and not _match(person.get("title", ""), title):
            continue
        total += 1
        t = team_name or "Unknown"
        by_team[t] = by_team.get(t, 0) + 1

    return json.dumps({"count": total, "by_team": by_team}, default=str)


# ---------------------------------------------------------------------------
# Teams
# ---------------------------------------------------------------------------


async def list_teams(ctx: RunContext[OrgPulseClient]) -> str:
    """List all teams with their member counts.

    Examples:
        "What teams do we have?" → list_teams()
        "Show me the teams and sizes" → list_teams()
    """
    roster = await ctx.deps.get_roster()
    if not roster:
        return json.dumps({"error": "Could not fetch roster data"})

    teams: dict[str, int] = {}
    for _, team_name, _ in _iter_people(roster):
        t = team_name or "Unknown"
        teams[t] = teams.get(t, 0) + 1

    result = [
        {"team": name, "member_count": count}
        for name, count in sorted(teams.items(), key=lambda x: x[1], reverse=True)
    ]
    return json.dumps(result, default=str)


async def get_team_details(ctx: RunContext[OrgPulseClient], team: str) -> str:
    """Get details for a specific team including its members.

    Args:
        team: Team name (case-insensitive match). Use list_teams first to find valid names.
    """
    roster = await ctx.deps.get_roster()
    if not roster:
        return json.dumps({"error": "Could not fetch roster data"})

    members = []
    for _, team_name, person in _iter_people(roster):
        if _match(team_name or "", team):
            members.append(
                {
                    "name": person.get("name"),
                    "uid": person.get("uid"),
                    "title": person.get("title"),
                    "email": person.get("email"),
                }
            )

    if not members:
        raise ModelRetry(
            f"Team '{team}' not found. Use list_teams to see available teams."
        )

    return json.dumps(
        {"team": team, "member_count": len(members), "members": members},
        default=str,
    )


# ---------------------------------------------------------------------------
# Jira Metrics
# ---------------------------------------------------------------------------


async def get_person_metrics(ctx: RunContext[OrgPulseClient], name: str) -> str:
    """Get Jira metrics for a person (resolved issues, story points, cycle time).

    Args:
        name: Person's display name. Use search_people first to find exact names.

    Examples:
        "How is John doing on Jira?" → get_person_metrics(name="John Smith")
    """
    data = await ctx.deps.get_person_metrics(name)
    if not data:
        raise ModelRetry(
            f"No Jira metrics found for '{name}'. "
            "Check the name spelling or use search_people to find the correct name."
        )

    return json.dumps(
        {
            "name": data.get("jiraDisplayName", name),
            "lookback_days": data.get("lookbackDays"),
            "resolved": {
                "count": data.get("resolved", {}).get("count", 0),
                "story_points": data.get("resolved", {}).get("storyPoints", 0),
            },
            "in_progress": {
                "count": data.get("inProgress", {}).get("count", 0),
                "story_points": data.get("inProgress", {}).get("storyPoints", 0),
            },
            "cycle_time": {
                "avg_days": data.get("cycleTime", {}).get("avgDays"),
                "median_days": data.get("cycleTime", {}).get("medianDays"),
            },
        },
        default=str,
    )


async def get_team_metrics(
    ctx: RunContext[OrgPulseClient], team: Optional[str] = None
) -> str:
    """Get aggregated Jira metrics. Returns org-wide totals by team if no team given.

    Args:
        team: Team name (optional). Omit to get metrics aggregated across all teams.

    Examples:
        "How many story points did we close?" → get_team_metrics()
        "How is the Platform team doing?" → get_team_metrics(team="Platform")
        "Compare team velocities" → get_team_metrics()
    """
    roster = await ctx.deps.get_roster()
    if not roster:
        return json.dumps({"error": "Could not fetch roster data"})

    people_by_team: dict[str, list[str]] = {}
    for _, team_name, person in _iter_people(roster):
        t = team_name or "Unknown"
        if team and not _match(t, team):
            continue
        people_by_team.setdefault(t, []).append(person.get("name"))

    if team and not people_by_team:
        raise ModelRetry(
            f"Team '{team}' not found. Use list_teams to see available teams."
        )

    total_resolved = 0
    total_points = 0
    total_in_progress = 0
    cycle_times = []
    team_summaries = []

    sem = asyncio.Semaphore(5)

    async def _fetch_with_team(t_name, name):
        async with sem:
            return t_name, name, await ctx.deps.get_person_metrics(name)

    all_tasks = [
        (t_name, name)
        for t_name, members in people_by_team.items()
        for name in members
    ]
    results = await asyncio.gather(*[_fetch_with_team(t, n) for t, n in all_tasks])

    team_data: dict[str, dict] = {}
    for t_name, _, data in results:
        if t_name not in team_data:
            team_data[t_name] = {
                "resolved": 0, "points": 0, "in_prog": 0, "cycles": [],
                "member_count": len(people_by_team[t_name]),
            }
        if not data:
            continue
        td = team_data[t_name]
        td["resolved"] += data.get("resolved", {}).get("count", 0)
        td["points"] += data.get("resolved", {}).get("storyPoints", 0)
        td["in_prog"] += data.get("inProgress", {}).get("count", 0)
        avg_ct = data.get("cycleTime", {}).get("avgDays")
        if avg_ct is not None:
            td["cycles"].append(avg_ct)

    for t_name, td in team_data.items():
        total_resolved += td["resolved"]
        total_points += td["points"]
        total_in_progress += td["in_prog"]
        cycle_times.extend(td["cycles"])
        team_summaries.append({
            "team": t_name,
            "member_count": td["member_count"],
            "resolved": td["resolved"],
            "story_points": td["points"],
            "in_progress": td["in_prog"],
            "avg_cycle_time_days": round(sum(td["cycles"]) / len(td["cycles"]), 1) if td["cycles"] else None,
        })

    avg_cycle = round(sum(cycle_times) / len(cycle_times), 1) if cycle_times else None

    return json.dumps(
        {
            "scope": team or "organization",
            "team_count": len(team_summaries),
            "total_members": sum(t["member_count"] for t in team_summaries),
            "total_resolved": total_resolved,
            "total_story_points": total_points,
            "total_in_progress": total_in_progress,
            "avg_cycle_time_days": avg_cycle,
            "teams": team_summaries,
        },
        default=str,
    )


# ---------------------------------------------------------------------------
# GitHub / GitLab Contributions
# ---------------------------------------------------------------------------


async def get_github_contributions(
    ctx: RunContext[OrgPulseClient], username: Optional[str] = None
) -> str:
    """Get GitHub contribution data. Returns all contributors sorted by total if no username given.

    Args:
        username: GitHub username (optional). Omit to get a ranked summary of all contributors.

    Examples:
        "Top GitHub contributors this month?" → get_github_contributions()
        "How active is bobsmith on GitHub?" → get_github_contributions(username="bobsmith")
    """
    data = await ctx.deps.get_github_contributions()
    if not data:
        return json.dumps({"error": "Could not fetch GitHub contribution data"})

    users = data.get("users", {})

    roster = await ctx.deps.get_roster()
    github_to_name = {}
    if roster:
        for _, _, person in _iter_people(roster):
            gh = person.get("githubUsername")
            if gh:
                github_to_name[gh] = person.get("name")

    if not username:
        ranked = sorted(
            [
                {
                    "username": u,
                    "name": github_to_name.get(u),
                    "total_contributions": d.get("totalContributions", 0),
                }
                for u, d in users.items()
            ],
            key=lambda x: x["total_contributions"],
            reverse=True,
        )
        return json.dumps({"contributors": ranked, "fetched_at": data.get("fetchedAt")}, default=str)

    user_data = users.get(username)
    if not user_data:
        available = list(users.keys())[:10]
        raise ModelRetry(
            f"GitHub user '{username}' not found. "
            f"Sample available usernames: {', '.join(available)}. "
            "Use search_people to find a person's GitHub username."
        )

    return json.dumps(
        {
            "username": username,
            "name": github_to_name.get(username),
            "total_contributions": user_data.get("totalContributions", 0),
            "months": user_data.get("months", {}),
            "fetched_at": user_data.get("fetchedAt"),
        },
        default=str,
    )


async def get_gitlab_contributions(
    ctx: RunContext[OrgPulseClient], username: Optional[str] = None
) -> str:
    """Get GitLab contribution data. Returns all contributors sorted by total if no username given.

    Args:
        username: GitLab username (optional). Omit to get a ranked summary of all contributors.

    Examples:
        "Top GitLab contributors?" → get_gitlab_contributions()
        "Show GitLab activity for carolw" → get_gitlab_contributions(username="carolw")
    """
    data = await ctx.deps.get_gitlab_contributions()
    if not data:
        return json.dumps({"error": "Could not fetch GitLab contribution data"})

    users = data.get("users", {})

    roster = await ctx.deps.get_roster()
    gitlab_to_name = {}
    if roster:
        for _, _, person in _iter_people(roster):
            gl = person.get("gitlabUsername")
            if gl:
                gitlab_to_name[gl] = person.get("name")

    if not username:
        ranked = sorted(
            [
                {
                    "username": u,
                    "name": gitlab_to_name.get(u),
                    "total_contributions": d.get("totalContributions", 0),
                }
                for u, d in users.items()
            ],
            key=lambda x: x["total_contributions"],
            reverse=True,
        )
        return json.dumps({"contributors": ranked, "fetched_at": data.get("fetchedAt")}, default=str)

    user_data = users.get(username)
    if not user_data:
        available = list(users.keys())[:10]
        raise ModelRetry(
            f"GitLab user '{username}' not found. "
            f"Sample available usernames: {', '.join(available)}. "
            "Use search_people to find a person's GitLab username."
        )

    result = {
        "username": username,
        "name": gitlab_to_name.get(username),
        "total_contributions": user_data.get("totalContributions", 0),
        "months": user_data.get("months", {}),
        "fetched_at": user_data.get("fetchedAt"),
    }
    if "instances" in user_data:
        result["instances"] = user_data["instances"]

    return json.dumps(result, default=str)


# ---------------------------------------------------------------------------
# Tool Registry
# ---------------------------------------------------------------------------

ALL_TOOLS = [
    Tool(
        _with_retry_tracking(search_people),
        metadata={
            "embedding_hints": "find people, search roster, who is, look up person, team members by name"
        },
    ),
    Tool(
        _with_retry_tracking(get_person_details),
        metadata={
            "embedding_hints": "person details, full profile, uid, email, manager, github gitlab username"
        },
    ),
    Tool(
        _with_retry_tracking(count_people),
        metadata={
            "embedding_hints": "how many people, count team members, headcount, team size"
        },
    ),
    Tool(
        _with_retry_tracking(list_teams),
        metadata={
            "embedding_hints": "list all teams, show teams, what teams exist, team names"
        },
    ),
    Tool(
        _with_retry_tracking(get_team_details),
        metadata={
            "embedding_hints": "team details, team members, who is on team, team roster"
        },
    ),
    Tool(
        _with_retry_tracking(get_person_metrics),
        metadata={
            "embedding_hints": "jira metrics, resolved issues, story points, cycle time, velocity, productivity"
        },
    ),
    Tool(
        _with_retry_tracking(get_team_metrics),
        metadata={
            "embedding_hints": "team metrics, team jira, team velocity, team story points, team performance"
        },
    ),
    Tool(
        _with_retry_tracking(get_github_contributions),
        metadata={
            "embedding_hints": "github contributions, commits, pull requests, github activity"
        },
    ),
    Tool(
        _with_retry_tracking(get_gitlab_contributions),
        metadata={
            "embedding_hints": "gitlab contributions, gitlab activity, gitlab commits"
        },
    ),
]
