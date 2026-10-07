"""Turn a preset config (ids + order) plus the bank into the concrete document to render."""


def resolve(bank: dict, config: dict) -> dict:
    sections = {s["id"]: s for s in bank["sections"]}
    out = []
    for cs in config.get("sections", []):
        s = sections.get(cs.get("id"))
        if not s:
            continue
        if s["kind"] == "skills":
            wanted = set(cs.get("skills", []))
            order = {k: i for i, k in enumerate(cs.get("skills", []))}
            groups = []
            for g in s["groups"]:
                picked = sorted((k for k in g["skills"] if k["id"] in wanted),
                                key=lambda k: order[k["id"]])
                if picked:
                    groups.append({"name": g["name"], "skills": [k["name"] for k in picked]})
            if groups:
                out.append({"title": s["title"], "kind": "skills", "groups": groups})
            continue
        entries = {e["id"]: e for e in s["entries"]}
        rendered = []
        for ce in cs.get("entries", []):
            e = entries.get(ce.get("id"))
            if not e:
                continue
            bullets = {b["id"]: b for b in e["bullets"]}
            texts = [bullets[b]["text"] for b in ce.get("bullets", [])
                     if b in bullets and not bullets[b]["archived"]]
            rendered.append({**{k: e[k] for k in ("kind", "title", "org", "date", "location", "tech")},
                             "bullets": texts})
        if rendered:
            out.append({"title": s["title"], "kind": "entries", "entries": rendered})
    return {
        "profile": bank["profile"],
        "sections": out,
        "skills_layout": config.get("skills_layout", "inline"),
    }
