"""Aggregate jobs into Sankey nodes and links."""
from collections import Counter

APPLIED = "Applied"
INTERVIEW = "Interview"
OFFER = "Offer"


def job_path(status: str, interviews: int):
    """The stages a single job has passed through, based on its current state."""
    if status == "not_applied":
        return None
    interviewed = interviews > 0 or status in ("interviewing", "rejected_after_interview")
    if status == "rejected" and interviewed:
        status = "rejected_after_interview"
    path = [APPLIED]
    if status == "applied":
        return path + ["No response yet"]
    if status == "rejected":
        return path + ["Rejected"]
    if interviewed:
        path.append(INTERVIEW)
    if status == "interviewing":
        return path + ["In progress"]
    if status == "rejected_after_interview":
        return path + ["Rejected after interview"]
    path.append(OFFER)
    if status == "offered":
        return path + ["Deciding"]
    if status == "accepted":
        return path + ["Accepted"]
    if status == "declined":
        return path + ["Declined"]
    return path


def build(jobs):
    links = Counter()
    nodes = Counter()
    total_interviews = 0
    applied = 0
    for j in jobs:
        path = job_path(j["status"], j.get("interview_count") or 0)
        if not path:
            continue
        applied += 1
        total_interviews += j.get("interview_count") or 0
        for n in path:
            nodes[n] += 1
        for a, b in zip(path, path[1:]):
            links[(a, b)] += 1
    names = list(nodes)
    idx = {n: i for i, n in enumerate(names)}
    return {
        "nodes": [{"name": n, "count": nodes[n]} for n in names],
        "links": [{"source": idx[a], "target": idx[b], "value": v} for (a, b), v in links.items()],
        "totals": {"applied": applied, "interviews": total_interviews,
                   "jobs_interviewed": nodes.get(INTERVIEW, 0), "offers": nodes.get(OFFER, 0)},
    }
