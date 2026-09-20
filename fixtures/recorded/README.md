# Recorded drills

Real terminal drills saved with `python -m chaukanna_agent.local --out ../../fixtures/recorded/<name>.json`.
Only runs by the team, with synthetic answers, ever go here: never a real learner's call.
`apps/agent/tests/test_recorded_runs.py` checks every file for the same invariants as the scripted
fixtures: nothing stored trips the tripwire, stages move one step at a time, the session ended once,
and the caller broke no hard limit.
