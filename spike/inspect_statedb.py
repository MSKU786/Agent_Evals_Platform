#!/usr/bin/env python3
"""Inspect a Hermes state.db and emit the trajectory as JSON.

Phase-0 spike tool. Read-only. Run with `python3 -I inspect_statedb.py <state.db>`.

Modes:
  (default)         Print {finalAnswer, steps[], tokens} for the latest session.
  --schema          Dump every table and its columns (used for the findings doc).
  --session <id>    Inspect a specific session id instead of the latest.
  --all-sessions    Include every session (e.g. a memory task's setup + eval).

The output shape is the Phase-0 exit-check contract:
    {"finalAnswer": str, "steps": [...], "tokens": {...}}
"""
import argparse
import json
import sqlite3
import sys


def connect_ro(path: str) -> sqlite3.Connection:
    """Open a quiescent Hermes state.db for reading.

    The DB is in WAL mode, so recently committed rows live in the ``-wal``
    sidecar until a checkpoint folds them in. A pure ``mode=ro`` URI open reads
    only the main file and misses them. Inspection always runs *after* the
    `hermes chat` process has exited (CLI-per-run), so the DB has no live
    writer: open it normally, which attaches the WAL and sees every committed
    row. We only read.
    """
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    return con


def table_names(con: sqlite3.Connection) -> list[str]:
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    return [r["name"] for r in rows]


def dump_schema(con: sqlite3.Connection) -> dict:
    out: dict = {}
    for t in table_names(con):
        cols = con.execute(f"PRAGMA table_info({t})").fetchall()
        try:
            count = con.execute(f"SELECT COUNT(*) AS c FROM {t}").fetchone()["c"]
        except sqlite3.Error:
            count = None
        out[t] = {
            "rows": count,
            "columns": [{"name": c["name"], "type": c["type"]} for c in cols],
        }
    return out


def _has_col(con: sqlite3.Connection, table: str, col: str) -> bool:
    return any(c["name"] == col for c in con.execute(f"PRAGMA table_info({table})"))


def latest_session_id(con: sqlite3.Connection) -> str | None:
    row = con.execute(
        "SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1"
    ).fetchone()
    return row["id"] if row else None


def session_ids(con: sqlite3.Connection) -> list[str]:
    return [
        r["id"]
        for r in con.execute("SELECT id FROM sessions ORDER BY started_at ASC")
    ]


def _maybe_json(value):
    if not value:
        return None
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return value


def steps_for(con: sqlite3.Connection, session_id: str) -> list[dict]:
    order_expr = "COALESCE(display_order, id)" if _has_col(con, "messages", "display_order") else "id"
    active_filter = " AND active = 1" if _has_col(con, "messages", "active") else ""
    rows = con.execute(
        f"""
        SELECT id, role, content, tool_name, tool_call_id, tool_calls,
               token_count, finish_reason
        FROM messages
        WHERE session_id = ?{active_filter}
        ORDER BY {order_expr} ASC, id ASC
        """,
        (session_id,),
    ).fetchall()
    steps = []
    for r in rows:
        steps.append(
            {
                "role": r["role"],
                "tool_name": r["tool_name"],
                "tool_call_id": r["tool_call_id"],
                "tool_calls": _maybe_json(r["tool_calls"]),
                "content": r["content"],
                "token_count": r["token_count"],
                "finish_reason": r["finish_reason"],
            }
        )
    return steps


def final_answer(steps: list[dict]) -> str:
    for step in reversed(steps):
        if step["role"] == "assistant" and (step["content"] or "").strip():
            return step["content"].strip()
    return ""


def tokens_for(con: sqlite3.Connection, session_id: str) -> dict:
    s = con.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    agg = {
        k: (s[k] if s and k in s.keys() else None)
        for k in (
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "reasoning_tokens",
            "tool_call_count",
            "message_count",
            "estimated_cost_usd",
            "actual_cost_usd",
            "cost_source",
            "model",
        )
    }
    by_model = []
    if "session_model_usage" in table_names(con):
        for r in con.execute(
            "SELECT model, task, billing_provider, api_call_count, input_tokens, "
            "output_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd "
            "FROM session_model_usage WHERE session_id = ?",
            (session_id,),
        ):
            by_model.append(dict(r))
    agg["by_model_and_task"] = by_model
    return agg


def report_session(con: sqlite3.Connection, session_id: str) -> dict:
    steps = steps_for(con, session_id)
    return {
        "sessionId": session_id,
        "finalAnswer": final_answer(steps),
        "steps": steps,
        "tokens": tokens_for(con, session_id),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("db", help="path to state.db")
    ap.add_argument("--schema", action="store_true")
    ap.add_argument("--session")
    ap.add_argument("--all-sessions", action="store_true")
    args = ap.parse_args()

    con = connect_ro(args.db)
    try:
        if args.schema:
            print(json.dumps(dump_schema(con), indent=2))
            return 0

        if args.all_sessions:
            out = [report_session(con, sid) for sid in session_ids(con)]
            print(json.dumps(out, indent=2, ensure_ascii=False))
            return 0

        sid = args.session or latest_session_id(con)
        if not sid:
            print(json.dumps({"error": "no sessions in state.db"}))
            return 1
        print(json.dumps(report_session(con, sid), indent=2, ensure_ascii=False))
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
