#!/usr/bin/env python3
"""v4 prompt-rewrite A/B — aggregate runs/*.json + judge-verdicts.json into
the RESULTS.md tables. Run: python3 aggregate.py (from this directory)."""
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "runs")

PROMPT_IDS = [f"AB-M{i}" for i in range(1, 7)] + [f"AB-C{i}" for i in range(1, 7)]


def load(pid, arm, attempt):
    path = os.path.join(RUNS, f"{pid}.{arm}.a{attempt}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def cell(r):
    if r is None:
        return "—"
    if not r["ok"]:
        return f"HARD-FAIL ({r['wallMs']/1000:.0f}s)"
    fv = "yes" if r["firstAttemptValid"] else "no"
    return f"{fv} / {r['fullAttempts']}fa+{r['repairRounds']}rr / {r['wallMs']/1000:.0f}s / {r['outputTokens']}tok"


def main():
    verdicts = {}
    vpath = os.path.join(RUNS, "judge-verdicts.json")
    if os.path.exists(vpath):
        with open(vpath) as f:
            for v in json.load(f):
                verdicts[v["promptId"]] = v

    print("| prompt | arm A a1 | arm A a2 | arm B a1 | arm B a2 | pairwise |")
    print("|---|---|---|---|---|---|")
    stats = {a: {"runs": 0, "firstValid": 0, "hard": 0, "repairRuns": 0, "walls": [], "toks": []} for a in "AB"}
    wins = {"A": 0, "B": 0, "tie": 0, "skipped": 0}
    for pid in PROMPT_IDS:
        row = [pid]
        for arm in "AB":
            for attempt in (1, 2):
                r = load(pid, arm, attempt)
                row.append(cell(r))
                if r is None:
                    continue
                s = stats[arm]
                s["runs"] += 1
                s["firstValid"] += 1 if r.get("firstAttemptValid") else 0
                s["hard"] += 0 if r["ok"] else 1
                s["repairRuns"] += 1 if r.get("repairRounds", 0) > 0 else 0
                s["walls"].append(r["wallMs"])
                s["toks"].append(r["outputTokens"])
        v = verdicts.get(pid)
        if v is None:
            row.append("—")
        else:
            o = {x["ordering"]: x["winnerArm"] for x in v["orderings"]}
            row.append(f"**{v['verdict']}** (AB={o.get('AB','?')}, BA={o.get('BA','?')})")
            wins[v["verdict"]] += 1
        print("| " + " | ".join(row) + " |")

    print()
    print("| metric | arm A (current) | arm B (v4 rewrite + end pass) |")
    print("|---|---|---|")
    a, b = stats["A"], stats["B"]

    def pct(n, d):
        return f"{n}/{d} ({100*n/d:.0f}%)" if d else "—"

    print(f"| first-attempt validity | {pct(a['firstValid'], a['runs'])} | {pct(b['firstValid'], b['runs'])} |")
    print(f"| runs needing repair rounds | {pct(a['repairRuns'], a['runs'])} | {pct(b['repairRuns'], b['runs'])} |")
    print(f"| hard failures | {pct(a['hard'], a['runs'])} | {pct(b['hard'], b['runs'])} |")
    for label, key in (("median wall-clock", "walls"), ("mean wall-clock", "walls")):
        fa = statistics.median(a[key]) if label.startswith("median") else statistics.mean(a[key])
        fb = statistics.median(b[key]) if label.startswith("median") else statistics.mean(b[key])
        print(f"| {label} | {fa/1000:.1f}s | {fb/1000:.1f}s |")
    print(f"| mean output tokens | {statistics.mean(a['toks']):.0f} | {statistics.mean(b['toks']):.0f} |")
    if verdicts:
        print(f"| pairwise judge (win/loss/tie) | {wins['A']}W | {wins['B']}W ({wins['tie']} ties) |")


if __name__ == "__main__":
    main()
