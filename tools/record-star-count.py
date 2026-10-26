#!/usr/bin/env python3
"""Record weekly public star-count snapshots without stargazer identities.

GitHub restricts access to the upstream repository's stargazer timestamps.
The public repository metadata endpoint still exposes the total star count.
This file records *observations*; it does not invent historical dates.
"""
import datetime as dt
import json
from pathlib import Path
from urllib.request import Request, urlopen

REPOSITORY = "XBuilderLAB/cheat-on-content"
API_URL = f"https://api.github.com/repos/{REPOSITORY}"
OUTPUT = Path(__file__).resolve().parent.parent / "docs" / "star-count-history.json"


def current_star_count():
    request = Request(
        API_URL,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "cheat-workbench-star-count-snapshot",
        },
    )
    with urlopen(request, timeout=20) as response:
        metadata = json.load(response)
    stars = metadata.get("stargazers_count")
    if type(stars) is not int or stars < 0:
        raise ValueError("GitHub returned an invalid stargazers_count")
    return stars


def main():
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    stars = current_star_count()

    if OUTPUT.exists():
        history = json.loads(OUTPUT.read_text(encoding="utf-8"))
        if history.get("repository") != REPOSITORY:
            raise ValueError("Snapshot repository does not match")
        samples = history.get("samples")
        if not isinstance(samples, list) or not all(
            isinstance(sample, dict)
            and isinstance(sample.get("date"), str)
            and type(sample.get("stars")) is int
            for sample in samples
        ):
            raise ValueError("Invalid star-count snapshot history")
    else:
        samples = []

    # Rerunning on the same UTC date replaces that observation, not duplicates it.
    samples = [sample for sample in samples if sample["date"] != today]
    samples.append({"date": today, "stars": stars})
    samples.sort(key=lambda sample: sample["date"])

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps({"repository": REPOSITORY, "samples": samples}, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(f"Recorded {REPOSITORY}: {stars:,} stars on {today} UTC")


if __name__ == "__main__":
    main()
