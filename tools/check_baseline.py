"""Baseline ratchet for checkers that have no baseline of their own: tsc, ruff and mypy.

Runs one checker, counts its findings per (file, code), and compares the counts with
checks-baseline.json. It fails when any count is higher than the baseline (a new finding,
or more of an old one). Lower counts pass, and it says how to shrink the baseline.
ESLint doesn't need this: it has its own (eslint-suppressions.json).

Canonical copy: nosv1/nosv1, standard/check_baseline.py (CODING.md, "Baselines"). Repos keep a
copy; change the hub's and copy it out. Python 3.10+, standard library only.

    python3 tools/check_baseline.py tsc -- npx tsc -p tsconfig.json --pretty false
    python3 tools/check_baseline.py ruff -- ruff check --output-format json .
    python3 tools/check_baseline.py mypy -- mypy src

    --section NAME  keep this run apart from another run of the same checker (two tsconfigs, say)
    --update   write today's counts; refused if any count grew
    --init     write today's counts even if they grew (only when the standard itself tightens)
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

BASELINE = Path("checks-baseline.json")
CHECKERS = ("tsc", "ruff", "mypy")
TIMEOUT_S = 900  # rule 2: the checker gets a fixed time, then it's a failure
MAX_OUTPUT_BYTES = 50_000_000  # rule 3: output read from the checker is capped
MAX_SHOWN = 40  # findings printed per run
CHECKER_FAILED = 2  # exit code when the checker itself didn't run properly

TSC_LINE = re.compile(r"^(?P<file>[^\s(][^(]*)\(\d+,\d+\): error (?P<code>TS\d+): ")
TSC_GLOBAL = re.compile(r"^error (?P<code>TS\d+): ")
MYPY_LINE = re.compile(r"^(?P<file>[^\s:][^:]*):\d+:(?:\d+:)? error: .*\[(?P<code>[a-z0-9-]+)\]\s*$")
SECTION = re.compile(r"^[a-z][a-z0-9_.-]{0,39}$")
MYPY_SUMMARY = re.compile(r"^(Found \d+ errors?|Success: no issues found)")

Counts = dict[str, dict[str, int]]  # file -> code -> count


class BaselineError(Exception):
    """A contract was broken: bad arguments, a checker that didn't run, a damaged baseline."""


def require(ok: bool, what: str) -> None:
    """Rule 5: a check that can't be stripped. Raises with what was expected."""
    if not ok:
        raise BaselineError(what)


def rel(path: str) -> str:
    """Repo-relative, forward-slash path, so the baseline matches on every machine."""
    require(path != "", "a finding has no file name")
    here = Path.cwd().resolve()
    full = (here / path).resolve()
    if full.is_relative_to(here):
        return full.relative_to(here).as_posix()
    return Path(path).as_posix()


def add(counts: Counts, path: str, code: str) -> None:
    require(code != "", f"a finding in {path} has no code")
    per_file = counts.setdefault(rel(path), {})
    per_file[code] = per_file.get(code, 0) + 1


def parse_tsc(out: str) -> Counts:
    counts: Counts = {}
    for line in out.splitlines():  # bounded: the output is capped
        hit = TSC_LINE.match(line)
        if hit:
            add(counts, hit["file"], hit["code"])
            continue
        whole = TSC_GLOBAL.match(line)
        if whole:  # a config error: it has no file
            counts.setdefault("<config>", {})[whole["code"]] = 1
    return counts


def parse_mypy(out: str) -> Counts:
    counts: Counts = {}
    seen_end = False
    for line in out.splitlines():
        hit = MYPY_LINE.match(line)
        if hit:
            add(counts, hit["file"], hit["code"])
        seen_end = seen_end or MYPY_SUMMARY.match(line) is not None
    require(seen_end or counts != {}, "mypy printed no summary line: did it run? (don't pass --no-error-summary)")
    return counts


def parse_ruff(out: str) -> Counts:
    try:
        items = json.loads(out)
    except json.JSONDecodeError as err:
        raise BaselineError(f"ruff output isn't JSON (use --output-format json): {err}") from err
    require(isinstance(items, list), "ruff JSON should be a list of findings")
    counts: Counts = {}
    for item in items:
        require(isinstance(item, dict) and isinstance(item.get("filename"), str), "ruff finding without a file")
        code = item.get("code")
        add(counts, str(item["filename"]), code if isinstance(code, str) and code else "syntax-error")
    return counts


def run_checker(checker: str, command: list[str]) -> Counts:
    """Runs the checker once and returns its findings. A checker that crashed is an error, not 'clean'."""
    require(checker in CHECKERS, f"checker must be one of {CHECKERS}")
    require(len(command) > 0, "give the checker's command after --")
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=TIMEOUT_S, check=False)  # noqa: S603 (the command is ours, from package.json or CI)
    except (OSError, subprocess.TimeoutExpired) as err:
        raise BaselineError(f"couldn't run {command[0]}: {err}") from err
    out = done.stdout
    require(len(out) <= MAX_OUTPUT_BYTES, f"{checker} printed more than {MAX_OUTPUT_BYTES} bytes")
    if checker == "tsc":
        counts = parse_tsc(out)
    elif checker == "mypy":
        counts = parse_mypy(out)
    else:
        counts = parse_ruff(out)
    if done.returncode != 0 and counts == {}:
        tail = (done.stderr or out)[-2000:]
        raise BaselineError(f"{checker} exited {done.returncode} with no findings it could read:\n{tail}")
    return counts


def load_baseline(path: Path) -> dict[str, Counts]:
    if not path.exists():
        return {}
    try:
        raw: object = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        raise BaselineError(f"can't read {path}: {err}") from err
    if not isinstance(raw, dict):
        raise BaselineError(f"{path} should hold an object keyed by section")
    data: dict[str, Counts] = {}
    for section, files in raw.items():
        require(SECTION.match(str(section)) is not None, f"{path}: bad section name {section!r}")
        require(isinstance(files, dict), f"{path}: {section} should map files to codes")
        data[section] = {}
        for name, codes in files.items():
            ok = isinstance(codes, dict) and all(isinstance(n, int) and n > 0 for n in codes.values())
            require(ok, f"{path}: {section} / {name} should map codes to positive counts")
            data[section][str(name)] = {str(c): int(n) for c, n in codes.items()}
    return data


def compare(now: Counts, base: Counts) -> tuple[list[str], list[str]]:
    """Returns (grew, shrank) as printable lines."""
    grew: list[str] = []
    shrank: list[str] = []
    for path in sorted(set(now) | set(base)):
        codes_now = Counter(now.get(path, {}))
        codes_base = Counter(base.get(path, {}))
        for code in sorted(set(codes_now) | set(codes_base)):
            n, b = codes_now[code], codes_base[code]
            if n > b:
                grew.append(f"  {path}: {code} {b} -> {n}")
            elif n < b:
                shrank.append(f"  {path}: {code} {b} -> {n}")
    return grew, shrank


def write_baseline(path: Path, data: dict[str, Counts], section: str, now: Counts) -> None:
    require(SECTION.match(section) is not None, f"bad section name {section!r}")
    if now:
        data[section] = {f: dict(sorted(c.items())) for f, c in sorted(now.items())}
    else:
        data.pop(section, None)
    path.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def report(checker: str, grew: list[str], shrank: list[str], total: int) -> None:
    print(f"{checker}: {total} findings now")
    if grew:
        print(f"{checker}: {len(grew)} new or grown (fix these; the baseline never grows):")
        print("\n".join(grew[:MAX_SHOWN]))
    if shrank:
        print(f"{checker}: {len(shrank)} fixed. Shrink the baseline: add --update to this command.")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("checker", choices=CHECKERS)
    parser.add_argument("--baseline", type=Path, default=BASELINE)
    parser.add_argument("--section", help="baseline section name (default: the checker's name)")
    parser.add_argument("--update", action="store_true", help="write today's counts (refused if any grew)")
    parser.add_argument("--init", action="store_true", help="write today's counts even if they grew")
    if "--" not in argv:
        parser.error("give the checker's command after --")
    split = argv.index("--")
    args = parser.parse_args(argv[:split])
    command = argv[split + 1 :]
    section: str = args.section or args.checker
    try:
        require(SECTION.match(section) is not None, f"bad section name {section!r}")
        now = run_checker(args.checker, command)
        data = load_baseline(args.baseline)
        grew, shrank = compare(now, data.get(section, {}))
        report(section, grew, shrank, sum(sum(c.values()) for c in now.values()))
        if args.init or (args.update and not grew):
            write_baseline(args.baseline, data, section, now)
            print(f"{section}: wrote {args.baseline}")
            return 0
    except BaselineError as err:
        print(f"check_baseline: {err}", file=sys.stderr)
        return CHECKER_FAILED
    if args.update:
        print(f"{section}: not written: the baseline only shrinks (--init is for a tighter standard)")
    return 1 if grew else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
