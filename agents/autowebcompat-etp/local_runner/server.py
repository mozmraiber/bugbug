# /// script
# requires-python = ">=3.14"
# dependencies = ["fastapi", "uvicorn", "requests", "python-dotenv"]
# ///
"""Local runner and review UI for the autowebcompat-etp agent.

Starts the agent through its compose.yml (the same way it ships), streams its
output to the browser, and once it is done renders the result next to a draft
of the Bugzilla changes. After you have edited and approved them, the changes
are posted with your own Bugzilla API key.

    pnpm --dir agents/autowebcompat-etp/local_runner/web install --frozen-lockfile
    pnpm --dir agents/autowebcompat-etp/local_runner/web build
    uv run --locked agents/autowebcompat-etp/local_runner/server.py

The server then serves the built React app from web/dist. To work on the UI,
run `pnpm dev` in web/ as well and open the Vite dev server, which proxies
/api here.

Secrets come from the repo-root `.env` (see agents/README.md):
ANTHROPIC_API_KEY for the agent, BUGZILLA_API_KEY for the broker and for
applying the reviewed actions.
"""

import base64
import json
import os
import queue
import re
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
WEB_DIST = HERE / "web" / "dist"
AGENT_DIR = HERE.parent
REPO_ROOT = AGENT_DIR.parent.parent
COMPOSE_FILE = AGENT_DIR / "compose.yml"
ENV_FILE = REPO_ROOT / ".env"
SERVICE = "autowebcompat-etp-agent"

load_dotenv(ENV_FILE)

# compose.yml bind-mounts this as the agent's ARTIFACTS_DIR.
ARTIFACTS_ROOT = Path(
    os.environ.get("HACKBOT_ARTIFACTS", Path.home() / "hackbot" / "artifacts")
)
BUGZILLA_REST = os.environ.get(
    "BUGZILLA_API_URL", "https://bugzilla.mozilla.org/rest"
).rstrip("/")
if not BUGZILLA_REST.endswith("/rest"):
    BUGZILLA_REST += "/rest"
BUGZILLA_ROOT = BUGZILLA_REST.removesuffix("/rest")

# Files the runner keeps next to the agent's own artifacts.
META_FILE = "runner-meta.json"
OUTPUT_FILE = "runner-output.log"
APPLIED_FILE = "runner-applied.json"

SCREENSHOT_LABELS = {
    "standard": "Standard ETP",
    "strict": "Strict ETP (broken)",
    "fixed": "Strict ETP with the proposed fix",
}

# How many agent runs execute at once; the rest wait in the queue.
MAX_PARALLEL = int(os.environ.get("MAX_PARALLEL", "1"))

# Untriaged ETP site reports: the REST equivalent of
# https://bugzilla.mozilla.org/buglist.cgi?resolution=---&query_format=advanced&product=Web%20Compatibility&component=Privacy%3A%20Site%20Reports&bug_severity=--&bug_type=defect
UNTRIAGED_QUERY = {
    "product": "Web Compatibility",
    "component": "Privacy: Site Reports",
    "resolution": "---",
    "bug_severity": "--",
    "bug_type": "defect",
}

# The Reporter header the agent log starts with when the input is a bug ID.
LOG_SUBJECT_RE = re.compile(r"^# bug (\d+)$", re.MULTILINE)
# Run IDs from this runner (etp-bug<id>-...) and from manual compose runs
# (etp-<id>-...).
RUN_ID_BUG_RE = re.compile(r"^etp-(?:bug)?(\d+)-")

TURN_RE = re.compile(r"^--- turn (\d+) ---$")
COST_RE = re.compile(r"cost=\$([\d.]+)")


@dataclass
class Run:
    run_id: str
    params: dict[str, Any]
    queued: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    status: str = "queued"  # queued | running | ok | error | cancelled
    lines: list[str] = field(default_factory=list)
    turns: int = 0
    cost: float | None = None
    process: subprocess.Popen | None = None
    changed: threading.Condition = field(default_factory=threading.Condition)

    @property
    def dir(self) -> Path:
        return ARTIFACTS_ROOT / self.run_id

    @property
    def container(self) -> str:
        return f"autowebcompat-etp-{self.run_id}"

    def add_line(self, line: str) -> None:
        if match := TURN_RE.match(line.strip()):
            self.turns = int(match.group(1))
        if line.startswith("[done]") and (match := COST_RE.search(line)):
            self.cost = float(match.group(1))
        with (self.dir / OUTPUT_FILE).open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        with self.changed:
            self.lines.append(line)
            self.changed.notify_all()

    def info(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "params": self.params,
            "status": self.status,
            "queued": self.queued,
            "started": self.started,
            "finished": self.finished,
            "turns": self.turns,
            "cost": self.cost,
            "active": True,
        }


RUNS: dict[str, Run] = {}
RUN_QUEUE: queue.Queue[Run] = queue.Queue()
# Guards a queued run's move to running or cancelled.
STATUS_LOCK = threading.Lock()

app = FastAPI(title="autowebcompat-etp local runner")


class StartRequest(BaseModel):
    bug_id: int | None = None
    bug_data: str | None = None
    model: str | None = None
    effort: str | None = None
    max_turns: int | None = None
    headless: bool = False
    build: bool = True


class BatchRequest(BaseModel):
    bug_ids: list[int]
    model: str | None = None
    effort: str | None = None
    max_turns: int | None = None
    headless: bool = False
    build: bool = True


class ApplyRequest(BaseModel):
    bug_id: int
    comment: str = ""
    changes: dict[str, Any] = {}
    attachments: list[str] = []
    force: bool = False


def run_dir(run_id: str) -> Path:
    path = (ARTIFACTS_ROOT / run_id).resolve()
    if path.parent != ARTIFACTS_ROOT.resolve() or not path.is_dir():
        raise HTTPException(404, f"unknown run {run_id}")
    return path


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError, json.JSONDecodeError:
        return None


def compose_cmd(*args: str) -> list[str]:
    cmd = ["docker", "compose", "-f", str(COMPOSE_FILE)]
    if ENV_FILE.exists():
        cmd += ["--env-file", str(ENV_FILE)]
    return cmd + list(args)


def execute(run: Run) -> None:
    params = run.params
    env_args: list[str] = ["-e", f"RUN_ID={run.run_id}"]
    for name in ("bug_id", "bug_data", "model", "effort", "max_turns"):
        if params.get(name) not in (None, ""):
            env_args += ["-e", f"{name.upper()}={params[name]}"]
    if params.get("headless"):
        env_args += ["-e", "HEADLESS=true"]

    cmd = compose_cmd(
        "run",
        "--rm",
        *(["--build"] if params.get("build") else []),
        "--name",
        run.container,
        *env_args,
        SERVICE,
    )
    shown = [arg if not arg.startswith("BUG_DATA=") else "BUG_DATA=…" for arg in cmd]
    run.add_line(f"$ {' '.join(shown)}")

    try:
        run.process = subprocess.Popen(
            cmd,
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            # compose.yml passes these through from the host environment.
            env={
                k: v for k, v in os.environ.items() if k not in ("BUG_ID", "BUG_DATA")
            },
        )
        assert run.process.stdout is not None
        for raw in run.process.stdout:
            run.add_line(raw.decode("utf-8", "replace").rstrip("\n"))
        code = run.process.wait()
    except Exception as exc:
        run.add_line(f"[runner] failed to run docker compose: {exc}")
        code = -1

    summary = read_json(run.dir / "summary.json")
    if run.status != "cancelled":
        run.status = (summary or {}).get("status") or ("ok" if code == 0 else "error")
    run.add_line(f"[runner] exited with code {code}, status {run.status}")
    with run.changed:
        run.finished = time.time()
        run.changed.notify_all()
    write_meta(run)


def worker() -> None:
    while True:
        run = RUN_QUEUE.get()
        with STATUS_LOCK:
            if run.status != "queued":  # cancelled while waiting
                continue
            run.status = "running"
            run.started = time.time()
        write_meta(run)
        try:
            execute(run)
        except Exception as exc:
            run.status = "error"
            run.add_line(f"[runner] {exc}")
            with run.changed:
                run.finished = time.time()
                run.changed.notify_all()
            write_meta(run)


for _ in range(MAX_PARALLEL):
    threading.Thread(target=worker, daemon=True).start()


def enqueue(params: dict[str, Any]) -> Run:
    subject = f"bug{params['bug_id']}" if params.get("bug_id") else "data"
    base = run_id = f"etp-{subject}-{datetime.now():%Y%m%d-%H%M%S}"
    suffix = 1
    while run_id in RUNS or (ARTIFACTS_ROOT / run_id).exists():
        suffix += 1
        run_id = f"{base}-{suffix}"
    run = Run(run_id=run_id, params=params)
    run.dir.mkdir(parents=True, exist_ok=True)
    write_meta(run)
    RUNS[run_id] = run
    RUN_QUEUE.put(run)
    return run


def write_meta(run: Run) -> None:
    meta = run.info() | {"active": False}
    (run.dir / META_FILE).write_text(json.dumps(meta, indent=2))


def stored_run_info(path: Path) -> dict[str, Any] | None:
    meta = read_json(path / META_FILE)
    summary = read_json(path / "summary.json")
    if meta is None:
        # A run started outside the runner; only list it if it's an ETP result.
        result = ((summary or {}).get("findings") or {}).get("result")
        if not isinstance(result, dict) or "proposed_exceptions" not in result:
            return None
        meta = {
            "run_id": path.name,
            "params": {"bug_id": guess_bug_id(path, result)},
            "status": summary.get("status"),
            "started": path.stat().st_mtime,
            "finished": path.stat().st_mtime,
            "turns": summary["findings"].get("num_turns"),
            "cost": summary["findings"].get("total_cost_usd"),
        }
    if meta.get("status") in ("queued", "running"):
        # Left behind by an earlier server process; a running container may
        # still finish and write summary.json.
        meta["status"] = (summary or {}).get("status") or "interrupted"
    meta["active"] = False
    meta["applied"] = (path / APPLIED_FILE).exists()
    return meta


# --- draft Bugzilla actions --------------------------------------------------


def tri_state(value: bool | None) -> str:
    return {True: "broken", False: "works", None: "not tested"}[value]


def draft_comment(result: dict[str, Any]) -> str:
    out = ["**Automated ETP investigation** (autowebcompat-etp agent)", ""]
    out += [result.get("summary", "").strip(), ""]
    out.append(f"- Standard ETP: {tri_state(result.get('broken_in_standard'))}")
    out.append(f"- Strict ETP: {tri_state(result.get('broken_in_strict'))}")
    if result.get("failure_reason"):
        out.append(f"- Outcome: `{result['failure_reason']}`")
    else:
        verified = "verified" if result.get("exception_verified") else "not verified"
        out.append(f"- Outcome: fix {verified} with skip-URL prefs")
    if prefs := result.get("culprit_prefs"):
        out.append("- Culprit prefs: " + ", ".join(f"`{p}`" for p in prefs))

    if blocked := result.get("blocked_resources"):
        out += ["", "**Blocked resources**", ""]
        out += [f"- {resource}" for resource in blocked]

    if records := result.get("exception_records"):
        out += ["", "**Proposed `url-classifier-exceptions` entries**", ""]
        out += ["```json", json.dumps(records, indent=2), "```", ""]
        for proposal in result.get("proposed_exceptions", []):
            out.append(f"- `{proposal['urlPattern']}`: {proposal['rationale']}")

    if shim := result.get("proposed_shim"):
        out += [
            "",
            f"**Proposed SmartBlock shim:** {shim['name']} (`{shim['kind']}`)",
            "",
        ]
        out.append("- Replaces: " + ", ".join(f"`{m}`" for m in shim["matches"]))
        if shim.get("unblocksOnOptIn"):
            out.append(
                "- Unblocks on opt-in: "
                + ", ".join(f"`{m}`" for m in shim["unblocksOnOptIn"])
            )
        if shim.get("existing_shim_id"):
            out.append(f"- Extends existing shim `{shim['existing_shim_id']}`")
        out.append(f"- Behavior: {shim['behavior']}")
        out.append(f"- Rationale: {shim['rationale']}")

    for key, title in (
        ("existing_exceptions", "Existing exception entries that overlap"),
        ("existing_shims", "Existing shims that overlap"),
    ):
        if existing := result.get(key):
            out += ["", f"**{title}**", ""]
            out += ["```json", json.dumps(existing, indent=2), "```"]

    if steps := result.get("steps"):
        out += ["", "**Steps**", "", steps.strip()]
    return "\n".join(out).strip() + "\n"


EXCEPTION_CATEGORY_TAG_RE = re.compile(r"\[exception-(baseline|convenience)\]")
DIAGNOSIS_LINE_PREFIXES = ("trackers-blocked:", "classifier-features:")


def draft_changes(result: dict[str, Any], bug_id: int | None) -> dict[str, Any]:
    """Whiteboard and user story edits that add the agent's diagnosis tags.

    Bugzilla replaces both fields whole, so the tags are merged into the bug's
    current values: earlier category tags and diagnosis lines are replaced.
    """
    tags = result.get("whiteboard_tags") or []
    lines = result.get("user_story_lines") or []
    if not bug_id or not (tags or lines):
        return {}
    try:
        bug = bugzilla(
            "GET",
            f"bug/{bug_id}",
            params={"include_fields": "whiteboard,cf_user_story"},
            auth_required=False,
        )["bugs"][0]
    except HTTPException, requests.RequestException, KeyError, IndexError:
        # Without the current values, a draft would clobber the fields.
        return {}

    changes = {}
    whiteboard = bug.get("whiteboard", "")
    if any(EXCEPTION_CATEGORY_TAG_RE.fullmatch(tag) for tag in tags):
        whiteboard = EXCEPTION_CATEGORY_TAG_RE.sub("", whiteboard)
    whiteboard += "".join(tag for tag in tags if tag not in whiteboard)
    if whiteboard != bug.get("whiteboard", ""):
        changes["whiteboard"] = whiteboard

    story = bug.get("cf_user_story", "")
    kept = [
        line
        for line in story.splitlines()
        if not line.strip().startswith(DIAGNOSIS_LINE_PREFIXES)
    ]
    new_story = "\n".join(kept + lines)
    if new_story != story:
        changes["cf_user_story"] = new_story
    return changes


def guess_bug_id(path: Path, result: dict[str, Any] | None = None) -> int | None:
    """The bug a run worked on, for runs started here or elsewhere."""
    meta = read_json(path / META_FILE) or {}
    if bug_id := (meta.get("params") or {}).get("bug_id"):
        return int(bug_id)
    try:
        with (path / "logs" / "agent.log").open(encoding="utf-8") as f:
            head = f.read(1024)
    except FileNotFoundError:
        head = ""
    if match := LOG_SUBJECT_RE.search(head):
        return int(match.group(1))
    for record in (result or {}).get("exception_records") or []:
        if record.get("bugIds"):
            return int(record["bugIds"][0])
    if match := RUN_ID_BUG_RE.match(path.name):
        return int(match.group(1))
    return None


# --- Bugzilla ----------------------------------------------------------------


def bugzilla_headers(required: bool = True) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key := os.environ.get("BUGZILLA_API_KEY"):
        headers["X-Bugzilla-API-Key"] = api_key
    elif required:
        raise HTTPException(400, f"BUGZILLA_API_KEY is not set (looked in {ENV_FILE})")
    return headers


def bugzilla(
    method: str,
    path: str,
    body: dict | None = None,
    params: dict[str, Any] | None = None,
    auth_required: bool = True,
) -> dict[str, Any]:
    response = requests.request(
        method,
        f"{BUGZILLA_REST}/{path}",
        json=body,
        params=params,
        headers=bugzilla_headers(auth_required),
        timeout=60,
    )
    if not response.ok:
        raise HTTPException(
            502, f"Bugzilla {method} {path}: {response.status_code} {response.text}"
        )
    return response.json()


# --- routes ------------------------------------------------------------------


@app.get("/api/config")
def config() -> dict[str, Any]:
    return {
        "artifacts_root": str(ARTIFACTS_ROOT),
        "bugzilla": BUGZILLA_ROOT,
        "env_file": str(ENV_FILE) if ENV_FILE.exists() else None,
        "has_anthropic_key": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "has_bugzilla_key": bool(os.environ.get("BUGZILLA_API_KEY")),
        "max_parallel": MAX_PARALLEL,
        "untriaged_url": f"{BUGZILLA_ROOT}/buglist.cgi?query_format=advanced&"
        + requests.compat.urlencode(UNTRIAGED_QUERY),
    }


@app.get("/api/untriaged")
def untriaged() -> list[dict[str, Any]]:
    data = bugzilla(
        "GET",
        "bug",
        params=UNTRIAGED_QUERY
        | {"include_fields": "id,summary,creation_time,url,status,whiteboard"},
        auth_required=False,
    )
    runs_by_bug: dict[int, list[dict[str, Any]]] = {}
    for run in list_runs():
        if bug_id := (run.get("params") or {}).get("bug_id"):
            runs_by_bug.setdefault(int(bug_id), []).append(
                {"run_id": run["run_id"], "status": run["status"]}
            )
    bugs = [bug | {"runs": runs_by_bug.get(bug["id"], [])} for bug in data["bugs"]]
    return sorted(bugs, key=lambda bug: bug["creation_time"], reverse=True)


@app.get("/api/whoami")
def whoami() -> dict[str, Any]:
    return bugzilla("GET", "whoami")


@app.post("/api/runs")
def start_run(req: StartRequest) -> dict[str, Any]:
    if (req.bug_id is None) == (not req.bug_data):
        raise HTTPException(400, "pass exactly one of bug_id or bug_data")
    return enqueue(req.model_dump()).info()


@app.post("/api/runs/batch")
def start_batch(req: BatchRequest) -> list[dict[str, Any]]:
    if not req.bug_ids:
        raise HTTPException(400, "no bugs selected")
    options = req.model_dump(exclude={"bug_ids"})
    runs = []
    for i, bug_id in enumerate(req.bug_ids):
        # One image build is enough for the whole batch.
        params = options | {"bug_id": bug_id, "build": req.build and i == 0}
        runs.append(enqueue(params).info())
    return runs


@app.get("/api/runs")
def list_runs() -> list[dict[str, Any]]:
    runs = {run_id: run.info() for run_id, run in RUNS.items()}
    if ARTIFACTS_ROOT.is_dir():
        for path in ARTIFACTS_ROOT.iterdir():
            if path.name in runs or not path.is_dir():
                continue
            if info := stored_run_info(path):
                runs[path.name] = info
    return sorted(
        runs.values(),
        key=lambda r: r.get("queued") or r.get("started") or 0,
        reverse=True,
    )


@app.post("/api/runs/{run_id}/cancel")
def cancel_run(run_id: str) -> dict[str, Any]:
    run = RUNS.get(run_id)
    if run is None or run.finished is not None:
        raise HTTPException(400, "run is not active")
    with STATUS_LOCK:
        was_queued = run.status == "queued"
        run.status = "cancelled"
    if was_queued:
        run.add_line("[runner] removed from the queue")
        with run.changed:
            run.finished = time.time()
            run.changed.notify_all()
        write_meta(run)
    else:
        run.add_line("[runner] cancelling…")
        subprocess.run(["docker", "stop", run.container], check=False)
    return run.info()


@app.get("/api/runs/{run_id}/stream")
def stream(run_id: str) -> StreamingResponse:
    run = RUNS.get(run_id)
    path = run_dir(run_id)

    def events():
        if run is None:
            output = path / OUTPUT_FILE
            lines = output.read_text().splitlines() if output.exists() else []
            for line in lines:
                yield f"data: {json.dumps(line)}\n\n"
            yield "event: end\ndata: {}\n\n"
            return
        sent = 0
        while True:
            while sent < len(run.lines):
                yield f"data: {json.dumps(run.lines[sent])}\n\n"
                sent += 1
            yield f"event: status\ndata: {json.dumps(run.info())}\n\n"
            if run.finished is not None:
                yield "event: end\ndata: {}\n\n"
                return
            with run.changed:
                run.changed.wait_for(
                    lambda n=sent: n < len(run.lines) or run.finished is not None,
                    timeout=5,
                )

    return StreamingResponse(events(), media_type="text/event-stream")


@app.get("/api/runs/{run_id}/review")
def review(run_id: str) -> dict[str, Any]:
    path = run_dir(run_id)
    summary = read_json(path / "summary.json")
    if summary is None:
        raise HTTPException(404, "no summary.json yet")
    findings = summary.get("findings") or {}
    result = findings.get("result")
    screenshots = {
        stage: key
        for stage, key in ((result or {}).get("screenshot_urls") or {}).items()
        if (path / key).is_file()
    }
    bug_id = guess_bug_id(path, result)
    return {
        "summary": summary,
        "result": result,
        "screenshots": screenshots,
        "screenshot_labels": SCREENSHOT_LABELS,
        "has_agent_log": (path / "logs" / "agent.log").is_file(),
        "applied": read_json(path / APPLIED_FILE),
        "draft": {
            "bug_id": bug_id,
            "comment": draft_comment(result) if result else "",
            "changes": draft_changes(result, bug_id) if result else {},
            "attachments": list(screenshots),
        },
    }


@app.get("/api/runs/{run_id}/files/{key:path}")
def artifact(run_id: str, key: str) -> FileResponse:
    root = run_dir(run_id)
    path = (root / key).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(path)


@app.post("/api/runs/{run_id}/apply")
def apply(run_id: str, req: ApplyRequest) -> dict[str, Any]:
    path = run_dir(run_id)
    applied_path = path / APPLIED_FILE
    if applied_path.exists() and not req.force:
        raise HTTPException(409, "already applied; tick 'apply again' to post anyway")
    result = ((read_json(path / "summary.json") or {}).get("findings") or {}).get(
        "result"
    ) or {}
    screenshot_keys = result.get("screenshot_urls") or {}

    done: list[dict[str, Any]] = []
    record = {
        "applied_at": datetime.now().isoformat(timespec="seconds"),
        "bug_id": req.bug_id,
        "url": f"{BUGZILLA_ROOT}/show_bug.cgi?id={req.bug_id}",
        "actions": done,
        "error": None,
    }
    body = dict(req.changes)
    if req.comment.strip():
        body["comment"] = {"body": req.comment, "is_markdown": True}
    try:
        for stage in req.attachments:
            key = screenshot_keys.get(stage)
            if key is None or not (path / key).is_file():
                raise HTTPException(400, f"no {stage} screenshot in this run")
        if body:
            bugzilla("PUT", f"bug/{req.bug_id}", body)
            done.append({"action": "update_bug", "fields": sorted(body)})
        for stage in req.attachments:
            key = screenshot_keys[stage]
            data = bugzilla(
                "POST",
                f"bug/{req.bug_id}/attachment",
                {
                    "ids": [req.bug_id],
                    "data": base64.b64encode((path / key).read_bytes()).decode(),
                    "file_name": f"{stage}.png",
                    "summary": f"Screenshot: {SCREENSHOT_LABELS.get(stage, stage)}",
                    "content_type": "image/png",
                },
            )
            done.append(
                {"action": "add_attachment", "stage": stage, "ids": data.get("ids")}
            )
    except HTTPException as exc:
        record["error"] = exc.detail
    # Record even a partial apply, so a retry doesn't silently double-post.
    if done:
        applied_path.write_text(json.dumps(record, indent=2))
    if record["error"]:
        raise HTTPException(502, record)
    return record


# Registered last so the API routes take precedence.
if WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
else:

    @app.get("/", response_class=HTMLResponse)
    def index() -> str:
        return (
            "<p>The UI isn't built. Run <code>pnpm install && pnpm build</code> "
            f"in <code>{HERE / 'web'}</code>, or <code>pnpm dev</code> there "
            "and use the Vite dev server.</p>"
        )


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8000")),
    )
