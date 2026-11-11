# Additive Subtractive Nonsense

Loaded by every devibe surface before it reports. Four jobs, one per heading —
a line that serves none of them belongs in another file.

| Heading | Its job |
| --- | --- |
| The rule | State the invariant, once, in the words every surface cites. |
| The test | Give the reader a decision they can apply to any artifact. |
| The exception | Separate a live constraint from narration of a past edit. |
| Reporting against it | Turn a judgment into a finding, or into a rewrite. |

## The rule

**When you remove something, remove it. Do not add words where the thing used to
be.**

A deletion that ships a comment explaining the deletion is not a deletion — it is
a rename. The line count went up, and the artifact now describes something it no
longer contains.

## The test

**A reader who has never seen the previous version must not be able to tell that
a previous version existed.**

Apply it to a comment, a docstring, a README line, a function nothing calls, a
screen nothing navigates to. If the artifact reveals its own history to someone
who never saw that history, it is carrying narration rather than content.

## The exception — forward-looking constraints stay

```text
 keep:   // Must stay above 300ms; Safari drops the event below that.
 keep:   // Do not add a retry here — the gateway retries; this double-fires.
 delete: // Removed the 250ms debounce because Safari was dropping events.
```

The distinction is not the word "removed" — it is whether the sentence binds
someone about to write code, or only tells them what someone else already did.

**Forward-looking: keep. Backward-looking: delete.**

## Reporting against it

Name **what a reader learns about the past** and **what they lose if it goes**.
When the second answer is "nothing", report it. When it isn't, the line carries a
live constraint in backward-looking clothes — recommend rewriting it forward
rather than deleting it.

The why is not destroyed by a deletion, it is relocated: to the commit body, the
PR description, or the reply to whoever asked. Not the file, which is read by
people who cannot see what the comment refers to.
