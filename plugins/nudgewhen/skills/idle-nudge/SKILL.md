---
name: idle-nudge
description: This skill should be used when asked for an "idle nudge", "is it necessary to sit idle" or "does this session need to stay open", when nudgewhen nudges the session idle, or before ending a turn to wait on CI, a deploy, a merge queue, an agent or a scheduled wake-up.
---

# Idle nudge

Is it absolutely necessary for you to be sitting here doing nothing and being idle?

You are sitting idle while holding background work. Sitting idle and doing nothing is not necessary, and it is not the default. Start from the answer "this session does not need to wait", and act on it now.

Every wait has somewhere better to be: hand it to a detached owner that outlives this session, do the step after it now, or do other open work beside it. Ending the turn only to wait is the wrong answer.

There is one way to stay idle: a valid reason. A wait is a valid reason only when both hold: the step after it needs this session's judgment and cannot be written down now as commands plus pass/fail checks, and something that matters is lost if this session closes first (a merge, a deploy, shipped or client work, data). State that reason in a `Needs me` line (the last section), naming what would be lost. These are not valid reasons: "it is still running", "it might need me", "it is easier to watch it here", "I will check back", or a result nobody will act on.

## 1. List every wait

Background shells, agents and teammates, workflows, monitors, crons, wake-ups and loops, and anything outside the session that the session intends to check back on: CI, a deploy, a merge queue, another worker. One line each: what it waits for, and what happens after. If nothing is waiting, end with `Can close: 0 waits.` and stop.

## 2. Still wanted?

For each wait, check that its result will still be used when it lands: the base branch has not moved under it, the commit is not superseded, the PR is still open. Cancel or restart a stale one. A wait whose result nobody will act on is not wanted: stop it now and say so in one line.

## 3. Decide

A wait needs this session only when both tests from the intro hold: the step after it needs judgment that cannot be written down now as commands plus pass/fail checks, and something that matters is lost if the session closes first. Fixed commands, gates with exit codes, bounded retries and notifications are mechanical. When in doubt, it is mechanical: hand it off.

## 4. Hand off the mechanical ones

Give each to a detached owner that outlives the session: a `nohup` or `setsid` script with a log, a terminal tab or multiplexer window, a system scheduler, CI or a hosted job, or the forge's auto-merge behind required checks. Never use a background shell or in-process agent of this session; both end with it. When the host offers no detached owner, keep the wait running: report it as `Needs me` if closing would lose something that matters, otherwise add a one-line note and no `Needs me` line.

- The owner runs every gate the session would have run, in order, and stops and records on any failure.
- Start the owner first and confirm it runs (its pid, its first log line). Then stop the in-session copy: stop the task, delete the cron.
- When a nudge started this run, it already listed the waits in its toast; start from that list and confirm each against the session's own tasks.

## 5. Record

One line per wait, in the reply and in the project's handoff notes if it keeps any:

`<wait> -> <owner and pid/job id> -> <log path> -> <what done looks like> -> <what a failure leaves>`

## 6. End with the summary line

`Can close: <n> waits handed off; record: <where>.`

or, when a wait has no detached owner and closing loses nothing that matters:

`Staying open: <n> waits left running, no detached owner; nothing lost on close.`

or, one `Needs me` line per wait that truly needs the session, each followed by up to four short sentences:

`Needs me: <wait>, because <reason>.`

Each `Needs me` line names what is lost if the session closes. A wait that would lose nothing that matters gets no `Needs me` line: it is handed off, or left running with a one-line note and counted in the `Staying open` line when no detached owner exists.

Write each `Needs me` line for a reader who knows nothing about the situation. In plain words, with no job ids, run ids or shorthand left unexplained:

- what is lost if the session closes first
- what the wait is, and why the session started it
- what it is waiting for
- what step comes after, and why that step needs judgment instead of a fixed command

Follow each `Needs me` line with one short sentence per point, four at most. The line stays as the summary.

## Traps

- A run on a head that moved: CI that passes on a superseded commit, or on a branch a merge would refuse, proves nothing. Check before handing it off.
- An owner that dies with the session: a background shell or in-process agent is not a handoff.
