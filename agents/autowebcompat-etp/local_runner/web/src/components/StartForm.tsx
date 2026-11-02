import type { FormEvent } from "react";
import { useSnapshot } from "valtio";

import { startRun } from "../actions";
import { store } from "../store";
import { RunOptionsFields } from "./RunOptionsFields";

export function StartForm() {
  const start = store.start;
  const snap = useSnapshot(start, { sync: true });

  function submit(e: FormEvent) {
    e.preventDefault();
    startRun();
  }

  return (
    <form onSubmit={submit}>
      <label>Bug ID</label>
      <input
        type="number"
        placeholder="e.g. 1900000"
        value={snap.bugId}
        onChange={(e) => (start.bugId = e.target.value)}
      />
      <details>
        <summary className="meta">…or paste report text instead</summary>
        <textarea
          rows={5}
          placeholder="Report text (BUG_DATA)"
          value={snap.bugData}
          onChange={(e) => (start.bugData = e.target.value)}
        />
      </details>
      <RunOptionsFields options={start.options} />
      {snap.error && <div className="note err">{snap.error}</div>}
      <button type="submit" className="wide" disabled={snap.busy}>
        Start run
      </button>
    </form>
  );
}
