# Agent Run progress policy

AES monitors run progress, model silence and repeated tool outcomes instead of imposing a default fixed total runtime. Operators can still configure an absolute deadline.

## Limits

- `WORKSPACE_AGENT_RUN_TIMEOUT_MS=0`: no absolute run deadline. A nonzero value remains an explicit operator override.
- `AGENT_LLM_TIMEOUT_MS=600000`: maximum silence during a model request, renewed by nonempty text, reasoning, or tool-argument deltas. It is no longer a total response duration limit. Initial connection/first output is subject to the same silence limit.
- `AGENT_RUN_IDLE_TIMEOUT_MS=600000`: maximum time without model deltas or completed tools. Partial tool output does not renew this lease. Existing per-tool deadlines remain in effect (currently default 30 seconds, maximum 60 seconds for ordinary commands).
- `AGENT_RUN_REPEAT_LIMIT=12`: stop after 12 consecutive tool completions whose identical name, arguments, error status, and content have already appeared in the recent 128 distinct outcomes. New outcomes reset the counter. This detects repeated calls and short cycles, including successful calls that do not produce new results.
- Token quotas, concurrency, CPU, memory, workspace limits and existing sandbox lifetimes remain enforced.

## Stopping and continuation

Warnings are written to the run trace at half the repeated-result threshold or 80% of the idle limit. Stops cancel the current session and use existing tool cancellation and cleanup. Code and conversation files remain; the user can send another message in the same conversation to continue. This is a stopped run, not suspended execution or automatic resumption of a process.

The heuristic does not prove a mathematical infinite loop. Legitimate repeated polling can trigger it; unique but unproductive output may evade it. A long silent command still needs its own appropriate tool deadline. Thresholds should be tuned from trial logs rather than disabling all limits.

## Output-limit recovery (2026-10-18)

`AGENT_LENGTH_RECOVERY_MAX_ATTEMPTS=2` allows up to two automatic continuations per run after a model response ends with `length`. Zero disables recovery. Model output limits themselves are unchanged.

AES reuses a successful automatic compaction following that response. Otherwise it requests compaction explicitly. After accounting for compaction tokens, it sends an automatic continuation message through the same Pi session and Agent Run. The summary retains the original task, constraints, work completed and remaining steps; workspace files remain in place. Successful normal answers are not automatically extended.

Compaction streams renew the same model-silence and run-idle leases as ordinary model streams. User cancellation, token quota, explicit run deadlines and repeated-tool detection still stop recovery; aborts also cancel compaction. Failed compaction never triggers a new task attempt. The recovery bound prevents repeated output-limit failures from retrying indefinitely. This cannot guarantee that a model will finish or avoid repeating work.

The run trace shows `pi:length_recovery`. Resource logs add `agent_run_length_recovery` with the attempt number and whether compaction was reused; `agent_run_finished` includes `recoveryAttempts`. No previously failed run is restarted by deployment.

Mock-provider regression tests cover automatic and explicit compaction, thinking-only output limits, long streaming summaries, cancellation, token quota, compaction failure and repeated length limits. Tests do not call a real model or modify student workspaces.

## Resource log details

Existing resource logs under `logs/` receive `agent_run_started`, minute-level `agent_run_progress`, `agent_run_progress_warning`, `agent_run_progress_stopped`, `agent_model_idle_timeout`, and `agent_run_finished`. They include run/workspace identifiers, elapsed/idle time, repetition counts and stop reason, without copying prompts, tool arguments or tool results into resource logs.

## Validation

Mock-provider tests exercise output continuing beyond the old response interval, silent requests, idle runs, repeated read loops, warnings and session cleanup. No external AI provider or live student data is used. Execution tests cover existing resource and cancellation behavior.
