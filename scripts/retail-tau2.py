#!/usr/bin/env python3
"""Run `retail-co` against the tau2-bench retail domain, and score it.

This is the retail counterpart to ``scripts/vending-sim.py``. Where that one
runs a business forward on a clock, this one replays **tau2-bench tasks** — a
customer's opening message, and the database end-state tau2 says a correct
handling produces — through a company whose desks each hold one remedy.

What it is for is the thing tau2 itself cannot ask. Its orchestrator wires
exactly one agent to one user simulator, with no agent-to-agent path, so it can
score whether an agent called the right tool but not whether an ORGANISATION
routed the work to the seat that owns it. Here `triage` can read and nothing
more, `exchanges` can swap but not refund, `refunds` the reverse — so a task
only completes if the case reaches the right desk and that desk settles which
remedy applies.

The servers are NOT in this repo. They live in `opencompany-tau2`, which
vendors tau2-bench (~850 MB, mostly benchmark data) and needs its own venv —
which is why this bundle ships five DISABLED placeholder entries in `mcp.json`
and this script repoints them at loopback. Start them first:

    cd ../opencompany-tau2
    uv run tau2-mcp --roles roles/retail.yaml --role triage        --http 8801 &
    uv run tau2-mcp --roles roles/retail.yaml --role exchanges     --http 8802 &
    uv run tau2-mcp --roles roles/retail.yaml --role refunds       --http 8803 &
    uv run tau2-mcp --roles roles/retail.yaml --role cancellations --http 8804 &
    uv run tau2-mcp --roles roles/retail.yaml --role amendments    --http 8805 &

Then, against a running ``opencompany serve --company companies/retail_co``:

    python3 scripts/retail-tau2.py --task 0
    python3 scripts/retail-tau2.py --tasks 0,1,2 --out run.json

Stdlib only, so it runs wherever ``python3`` does. Exit status is the number of
tasks whose end-state did not match tau2's `evaluation_criteria`, so a CI-style
caller can treat zero as "the company handled every case correctly".
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

COMPANY = "retail-co"
SCOPE = f"/api/v1/companies/{COMPANY}"
ADMIN_EMAIL = "harness-e2e@tinyhumans.ai"

# Seat -> loopback port, in the order the servers are started above. The names
# are the `mcp.json` entries this repoints; a name not declared there is added.
SEATS = {
    "triage": 8801,
    "exchanges": 8802,
    "refunds": 8803,
    "cancellations": 8804,
    "amendments": 8805,
}

# Every task enters at the front desk, the way a customer would. Which desk it
# reaches after that is the thing being measured.
ENTRY_DESK = "triage"


class Host:
    """The running company, over its HTTP API."""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar)
        )

    def call(self, method: str, path: str, body: Any = None, timeout: float = 120):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("accept", "application/json")
        if data is not None:
            req.add_header("content-type", "application/json")
        try:
            with self.opener.open(req, timeout=timeout) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as err:
            raw = err.read()
            try:
                return err.code, json.loads(raw)
            except ValueError:
                return err.code, raw.decode(errors="replace")

    def sign_in(self) -> None:
        """No-op when auth is `none`; otherwise the loopback dev-code flow."""
        status, _ = self.call("GET", f"{SCOPE}/chat/history?limit=1")
        if status == 200:
            return
        status, body = self.call("POST", f"{SCOPE}/auth/request", {"email": ADMIN_EMAIL})
        code = (body or {}).get("dev_code") if isinstance(body, dict) else None
        if not code:
            raise SystemExit(f"sign-in: no dev_code from auth/request ({status}: {body})")
        status, body = self.call("POST", f"{SCOPE}/auth/verify", {"code": code})
        if status >= 300:
            raise SystemExit(f"sign-in: verify refused ({status}: {body})")

    def register_mcp(self, name: str, endpoint: str) -> tuple[int, Any]:
        """Point one declared server at this run's loopback role server.

        Runtime is the only layer that accepts an ``http://`` endpoint — a
        server declared in a bundle's ``mcp.json`` must be ``https``. That is
        why this bundle ships all five disabled and pointing at placeholders.

        **PUT, not POST.** The name is already declared, so adding it is a 409
        telling you to override instead — and a POST that 409s leaves the desks
        holding the shipped, disabled placeholder and deliberating confidently
        with no tools at all.
        """
        status, body = self.call(
            "PUT",
            f"{SCOPE}/mcp/servers/{urllib.parse.quote(name)}",
            {"endpoint": endpoint, "enabled": True},
        )
        if status < 300:
            return status, body
        return self.call(
            "POST", f"{SCOPE}/mcp/servers", {"name": name, "endpoint": endpoint}
        )

    def say(self, desk: str, text: str, timeout: float = 3600):
        """Put one message to `desk`, holding the POST open for the turn."""
        return self.call("POST", f"{SCOPE}/chat", {"text": text, "chat": desk}, timeout=timeout)


def load_tasks(data_dir: Path) -> list[dict]:
    path = data_dir / "tau2" / "domains" / "retail" / "tasks.json"
    if not path.exists():
        raise SystemExit(
            f"no tau2 task file at {path}\n"
            "Pass --tau2 pointing at the opencompany-tau2 checkout's "
            "vendor/tau2-bench/data directory."
        )
    raw = json.loads(path.read_text())
    return raw if isinstance(raw, list) else raw.get("tasks", [])


def opening_message(task: dict) -> str:
    """The customer's first line, as tau2 states it.

    `known_info` carries the identity the agent has to establish (name, zip),
    which a real customer would volunteer; `reason_for_call` is what they want.
    """
    ui = (task.get("user_scenario") or {}).get("instructions") or {}
    known = (ui.get("known_info") or "").strip()
    reason = (ui.get("reason_for_call") or "").strip()
    return f"{known}\n\n{reason}".strip() if known else reason


def expected_writes(task: dict) -> list[dict]:
    """The mutating actions tau2 says a correct handling performs."""
    actions = (task.get("evaluation_criteria") or {}).get("actions") or []
    return [a for a in actions if a.get("name", "").startswith(
        ("exchange_", "return_", "cancel_", "modify_")
    )]


def grade(task: dict, state: dict) -> tuple[bool, str]:
    """Compare the shared retail DB against tau2's expected end state.

    Only the write actions are graded. Reads are how an agent gets there, and
    tau2's own scoring does not require a particular path through them — two
    correct handlings can read different things.
    """
    wants = expected_writes(task)
    if not wants:
        return True, "no write expected"
    problems = []
    for want in wants:
        args = want.get("arguments") or {}
        oid = args.get("order_id")
        order = (state.get("orders") or {}).get(oid)
        if order is None:
            problems.append(f"{want['name']}: order {oid} not in state")
            continue
        name = want["name"]
        if name == "exchange_delivered_order_items":
            ok = (
                order.get("status") == "exchange requested"
                and order.get("exchange_items") == args.get("item_ids")
                and order.get("exchange_new_items") == args.get("new_item_ids")
                and order.get("exchange_payment_method_id") == args.get("payment_method_id")
            )
        elif name == "return_delivered_order_items":
            ok = (
                order.get("status") == "return requested"
                and order.get("return_items") == args.get("item_ids")
                and order.get("return_payment_method_id") == args.get("payment_method_id")
            )
        elif name == "cancel_pending_order":
            ok = order.get("status") == "cancelled"
        else:
            # A modify_*: the tools are once-per-order, so the end state is the
            # comparison — not which call produced it.
            ok = order.get("status") == "pending"
        if not ok:
            problems.append(f"{name}: end state does not match (status={order.get('status')!r})")
    return (not problems), "; ".join(problems) or "matches"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://127.0.0.1:8080", help="running `opencompany serve`")
    ap.add_argument("--tau2", type=Path, default=Path("../opencompany-tau2"),
                    help="the opencompany-tau2 checkout (for tasks + shared state)")
    ap.add_argument("--task", help="one tau2 retail task id")
    ap.add_argument("--tasks", help="comma-separated task ids")
    ap.add_argument("--host", default="127.0.0.1", help="host the role servers bound to")
    ap.add_argument("--out", type=Path, help="write the run as JSON")
    ap.add_argument("--timeout", type=float, default=3600, help="seconds to hold one turn open")
    args = ap.parse_args()

    ids = []
    if args.task:
        ids = [args.task]
    if args.tasks:
        ids += [t.strip() for t in args.tasks.split(",") if t.strip()]
    if not ids:
        ap.error("pass --task or --tasks")

    tasks = {str(t["id"]): t for t in load_tasks(args.tau2 / "vendor" / "tau2-bench" / "data")}
    missing = [i for i in ids if i not in tasks]
    if missing:
        raise SystemExit(f"no such retail task(s): {', '.join(missing)}")

    state_path = args.tau2 / ".state" / "retail.json"

    host = Host(args.base)
    host.sign_in()
    for seat, port in SEATS.items():
        name = f"tau2-retail-{seat}"
        status, body = host.register_mcp(name, f"http://{args.host}:{port}/mcp")
        if status >= 300:
            raise SystemExit(f"could not register {name}: {status} {body}")
    print(f"registered {len(SEATS)} role servers", file=sys.stderr)

    results = []
    failed = 0
    for tid in ids:
        task = tasks[tid]
        text = opening_message(task)
        print(f"\n=== task {tid} ===\n{text}\n", file=sys.stderr)
        status, body = host.say(ENTRY_DESK, text, timeout=args.timeout)
        replies = [r.get("text") for r in (body or {}).get("responses", [])] if isinstance(body, dict) else []
        for r in replies:
            print(f"  [{ENTRY_DESK}] {r}", file=sys.stderr)

        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        ok, why = grade(task, state)
        failed += 0 if ok else 1
        print(f"  -> {'PASS' if ok else 'FAIL'} ({why})", file=sys.stderr)
        results.append({"id": tid, "status": status, "passed": ok, "detail": why, "replies": replies})

    if args.out:
        args.out.write_text(json.dumps({"results": results}, indent=2) + "\n")
        print(f"\nwrote {args.out}", file=sys.stderr)
    print(f"\n{len(ids) - failed}/{len(ids)} passed", file=sys.stderr)
    return failed


if __name__ == "__main__":
    raise SystemExit(main())
