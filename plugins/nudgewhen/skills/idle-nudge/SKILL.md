---
name: idle-nudge
description: This skill should be used when asked for an "idle nudge", "is it necessary to sit idle" or "does this session need to stay open", when nudgewhen nudges the session idle, or before ending a turn to wait on CI, a deploy, a merge queue, an agent or a scheduled wake-up.
---

# Idle nudge

Decide whether it is necessary for this session to sit idle, wait by wait.

## 1. List every wait

Background shells, agents and teammates, workflows, monitors, crons, wake-ups and loops, and anything outside the session that the session intends to check back on: CI, a deploy, a merge queue, another worker. One line each: what it waits for, and what happens after. If nothing is waiting, end with `Can close: 0 waits.` and stop.

## 2. Still wanted?

For each wait, check that its result will still be used when it lands: the base branch has not moved under it, the commit is not superseded, the PR is still open. Cancel or restart a stale one.

## 3. Decide

A wait needs this session only when the step after it needs judgment that cannot be written down now as commands plus pass/fail checks. Fixed commands, gates with exit codes, bounded retries and notifications are mechanical.

## 4. Hand off the mechanical ones

Give each to a detached owner that outlives the session: a `nohup` or `setsid` script with a log, a terminal tab or multiplexer window, a system scheduler, CI or a hosted job, or the forge's auto-merge behind required checks. Never use a background shell or in-process agent of this session; both end with it. When the host offers no detached owner, keep the wait and report it as `Needs me`.

- The owner runs every gate the session would have run, in order, and stops and records on any failure.
- Start the owner first and confirm it runs (its pid, its first log line). Then stop the in-session copy: stop the task, delete the cron.
- When a nudge started this run, it already listed the waits in its toast; start from that list and confirm each against the session's own tasks.

## 5. Record

One line per wait, in the reply and in the project's handoff notes if it keeps any:

`<wait> -> <owner and pid/job id> -> <log path> -> <what done looks like> -> <what a failure leaves>`

## 6. End with the summary line

`Can close: <n> waits handed off; record: <where>.`

or, one line per wait that truly needs the session:

`Needs me: <wait>, because <reason>.`

Write each `Needs me` line for a reader who knows nothing about the situation. In plain words, with no job ids, run ids or shorthand left unexplained:

- what the wait is, and why the session started it
- what it is waiting for
- what step comes after, and why that step needs judgment instead of a fixed command
- what happens if the session closes first

Follow each `Needs me` line with one short sentence per point, four at most. The line stays as the summary.

## Traps

- A run on a head that moved: CI that passes on a superseded commit, or on a branch a merge would refuse, proves nothing. Check before handing it off.
- An owner that dies with the session: a background shell or in-process agent is not a handoff.
