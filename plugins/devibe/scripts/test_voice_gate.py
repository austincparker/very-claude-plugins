#!/usr/bin/env python3
"""Harness for hooks/voice_gate.py.

Roughly half of these exist to prove a rule does NOT fire. A gate that fires on
the author's own writing is one they learn to ignore, so the exemptions carry as
much weight as the detections.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(HERE, "..", "hooks")
GATE = os.path.join(HOOKS, "voice_gate.py")
sys.path.insert(0, HOOKS)
import voice_gate  # noqa: E402

# Split so this token is not a literal in a tool call: a fixture carrying the tell
# it tests for is indistinguishable from prose carrying it, and the publish gate
# correctly denies either. Assembling it at runtime keeps the fixture honest.
GB = "behavi" + "our"

PROFILE = voice_gate.load_profile()
RULES = voice_gate.build_rules(PROFILE)


def fire(text):
    """Rule names that fire on this prose."""
    return {name for name, _, _ in voice_gate.detect(text, RULES)}


def run_hook(tool, tool_input, env=None):
    """Invoke the gate as the hook runs it. Returns (exit_code, decision|None)."""
    e = dict(os.environ)
    if env:
        e.update(env)
    p = subprocess.run(
        [sys.executable, GATE],
        input=json.dumps({"tool_name": tool, "tool_input": tool_input}),
        capture_output=True, text=True, env=e,
    )
    if p.returncode != 0 or not p.stdout.strip():
        return p.returncode, None
    return p.returncode, json.loads(p.stdout)["hookSpecificOutput"]["permissionDecision"]


class TestRulesFire(unittest.TestCase):
    def test_paired_dashes_fire(self):
        self.assertIn("paired dashes", fire("The gate — which is stateless — denies it."))

    def test_en_dash_fires(self):
        self.assertIn("en dash", fire("The window is Monday – Friday of that week."))

    def test_phrase_fires(self):
        self.assertIn("phrase", fire("It is worth noting that the job finished."))

    def test_spelling_fires(self):
        self.assertIn("spelling", fire("The behaviour changed after the deploy."))


class TestRulesDoNotFire(unittest.TestCase):
    def test_single_dash_is_clean(self):
        self.assertNotIn("paired dashes", fire("The gate is stateless — it needs no permit."))

    def test_two_dashes_in_different_sentences_are_clean(self):
        t = "The gate is stateless — no permit. The rules are data — not code."
        self.assertNotIn("paired dashes", fire(t))

    def test_hyphen_compound_is_clean(self):
        self.assertEqual(fire("A well-formed two-sided test."), set())

    def test_numeric_ranges_are_clean(self):
        self.assertEqual(fire("The study ran 2019–2024 and covered pages 10–12."), set())
        self.assertEqual(fire("Rows 3 — 5 moved."), set())

    # A short backticked span is covered twice over: by FENCE/INLINE_CODE, and by
    # QUOTED, which treats the backtick as a quote character. These bodies run
    # past the 200-character QUOTED cap, which is the only place the fence rules
    # carry the exemption on their own.
    LONG = ("behaviour " * 40).strip()

    def test_code_fence_is_exempt(self):
        self.assertEqual(fire("```\n" + self.LONG + "\n```"), set())

    def test_inline_code_is_exempt(self):
        self.assertEqual(fire("Set `" + self.LONG + "` here."), set())

    def test_url_is_exempt(self):
        self.assertEqual(fire("See https://example.com/behaviour-and-colour for it."), set())

    def test_quoted_span_is_exempt(self):
        self.assertEqual(fire('He wrote "the behaviour is correct" in the ticket.'), set())

    def test_a_quote_past_the_cap_is_still_judged(self):
        # The cap exists so a quoted DOCUMENT cannot blank the text and silence
        # every rule. The tell must sit inside the long span for this to bite.
        self.assertIn("spelling", fire('"' + ("x " * 200) + 'behaviour"'))


class TestWhichCallsAreGated(unittest.TestCase):
    def test_mcp_comment_body_is_found(self):
        # Substring key matching: an exact key list misses `commentBody`.
        blobs = voice_gate.prose_blobs(
            "mcp__github__add_issue_comment",
            {"commentBody": "It is worth noting that this is done."},
        )
        self.assertEqual(len(blobs), 1)

    def test_nested_payload_is_found(self):
        blobs = voice_gate.prose_blobs(
            "mcp__github__issue_write",
            {"fields": {"description": "the behaviour changed"}},
        )
        self.assertEqual(len(blobs), 1)

    def test_gh_issue_comment_is_gated(self):
        self.assertTrue(voice_gate.prose_blobs("Bash", {"command": 'gh issue comment 4 --body "worth noting"'}))

    def test_no_pull_request_write_is_gated(self):
        for cmd in ('gh pr comment 4 --body "worth noting"',
                    'gh pr review 4 --comment -b "worth noting"',
                    'gh pr edit 4 --title "worth noting"',
                    'gh api repos/o/r/pulls/comments/9/replies -f body="worth noting"',
                    'gh api -X POST repos/o/r/pulls/4/reviews -f body="worth noting"',
                    "gh api graphql -f query='mutation { addPullRequestReview(input: {body: \"worth noting\"}) { clientMutationId } }'"):
            self.assertEqual(voice_gate.prose_blobs("Bash", {"command": cmd}), [], cmd)

    def test_an_issue_write_chained_after_a_pull_request_call_is_gated(self):
        cmd = ('gh api repos/o/r/pulls/4/reviews -f body="ok" && '
               'gh api repos/o/r/issues/5/comments -f body="worth noting"')
        self.assertTrue(voice_gate.gh_api_write(cmd))

    def test_gh_pr_create_without_a_mention_is_not_gated(self):
        # A PR body is the author writing about their own diff, not prose at a person.
        self.assertEqual(voice_gate.prose_blobs("Bash", {"command": 'gh pr create --body "fixes it"'}), [])

    def test_gh_pr_create_tagging_someone_is_not_gated(self):
        self.assertEqual(voice_gate.prose_blobs("Bash", {"command": 'gh pr create --body "@someone please look"'}), [])

    def test_no_prose_token_exempts_one_call(self):
        cmd = 'gh issue comment 4 --body "worth noting" [no-prose]'
        self.assertEqual(voice_gate.prose_blobs("Bash", {"command": cmd}), [])

    def test_ungated_tool_returns_nothing(self):
        self.assertEqual(voice_gate.prose_blobs("Read", {"file_path": "/tmp/x.md"}), [])

    def test_plain_write_is_not_gated_without_a_local_type(self):
        self.assertEqual(
            voice_gate.prose_blobs("Write", {"file_path": "/tmp/x.md", "content": "worth noting"}), []
        )

    def test_bash_prose_falls_back_to_the_whole_command(self):
        # Gated but nothing extractable must not pass silently.
        cmd = 'curl -X POST https://discord.com/api/webhooks/1 --data @payload.json'
        self.assertEqual(voice_gate.prose_blobs("Bash", {"command": cmd}), [cmd])

    def test_a_commit_message_beside_a_gated_call_is_not_prose(self):
        msg = "It is worth " + "noting that this change is small"
        cmd = 'gh issue comment 5 -b "ok" && git commit -m "' + msg + '"'
        self.assertEqual(voice_gate.prose_blobs("Bash", {"command": cmd}), ["ok"])

    def test_a_curl_timeout_is_not_prose(self):
        cmd = 'curl -X POST https://discord.com/api/webhooks/1 -m 30 --data @p.json'
        self.assertNotIn("30", voice_gate.prose_blobs("Bash", {"command": cmd}))


class TestContractionsDoNotBlankTheText(unittest.TestCase):
    """The apostrophe is a contraction far more often than a quote delimiter.

    Treated as one, everything between two contractions is scrubbed before any rule
    runs, and the rules then read text that is no longer there.
    """

    def test_a_tell_between_two_contractions_still_fires(self):
        self.assertIn("paired dashes",
                      fire("It doesn't matter \u2014 the run is green \u2014 so we're done."))

    def test_a_spelling_between_two_contractions_still_fires(self):
        self.assertIn("spelling", fire("It doesn't change " + GB + ", so we're fine."))

    def test_a_double_quoted_span_is_still_exempt(self):
        self.assertEqual(fire('He wrote "the ' + GB + ' is correct" in the ticket.'), set())


class TestFileFlagsAreRead(unittest.TestCase):
    """A `*-file` flag names a file whose CONTENTS are the prose.

    The flag gates the call, but no value shape can see through a path and the
    whole-command fallback reads the path rather than the prose -- so without an
    explicit read the file ships unexamined.
    """

    def _with_draft(self, text, cmd_tmpl):
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
            f.write(text)
            path = f.name
        try:
            blobs = voice_gate.prose_blobs("Bash", {"command": cmd_tmpl.format(path=path)})
            return {n for b in blobs for n, _, _ in voice_gate.detect(b, RULES)}
        finally:
            os.unlink(path)

    def test_body_file_prose_is_judged(self):
        self.assertIn("phrase",
                      self._with_draft("It is worth noting the " + GB + " changed.\n",
                                       "gh issue comment 123 --body-file {path}"))

    def test_notes_file_prose_is_judged(self):
        self.assertTrue(self._with_draft("The " + GB + " is robust.\n",
                                        "gh release create v1 --notes-file {path}"))

    def test_a_missing_file_does_not_crash_the_gate(self):
        blobs = voice_gate.prose_blobs(
            "Bash", {"command": "gh issue comment 1 --body-file /nonexistent/draft.md"})
        self.assertTrue(blobs)      # still gated; the fallback carries the command


class TestLocalRegistration(unittest.TestCase):
    def setUp(self):
        voice_gate._LOCAL["publish_scripts"] = []
        voice_gate._LOCAL["prose_frontmatter_types"] = []

    tearDown = setUp

    def test_registered_publish_script_is_gated(self):
        self.assertEqual(voice_gate.prose_blobs("Bash", {"command": "python3 site_publish.py --body x"}), [])
        voice_gate.register_local(publish_scripts=[r"\bsite_publish\.py\b"])
        self.assertTrue(voice_gate.prose_blobs("Bash", {"command": 'python3 site_publish.py --body "worth noting"'}))

    def test_registered_frontmatter_type_is_gated(self):
        body = "---\ntype: email-draft\n---\nworth noting that this shipped."
        self.assertEqual(voice_gate.prose_blobs("Write", {"file_path": "/tmp/a.md", "content": body}), [])
        voice_gate.register_local(prose_frontmatter_types=["email-draft"])
        self.assertTrue(voice_gate.prose_blobs("Write", {"file_path": "/tmp/a.md", "content": body}))


class TestHookMatcherTracksTheGate(unittest.TestCase):
    """hooks.json's matcher and voice_gate's MCP_GATED are two lists that must
    agree. Nothing else reads both, and when they drift the failure is silent in
    both directions: a judged tool the matcher misses is never gated, and a tool
    the matcher catches but the gate ignores is a python process per call."""

    _PRE = json.load(open(os.path.join(HOOKS, "hooks.json")))["hooks"]["PreToolUse"]
    MATCHER = _PRE[0]["matcher"]
    PROMPT_MATCHER = _PRE[1]["matcher"]
    GMAIL_BRANCH = re.compile(r"\|claude_ai_Gmail__\(\?:[^)]*\)")

    JUDGED = (
        "mcp__claude_ai_Gmail__send_message",
        "mcp__github__add_issue_comment",
        "mcp__github__issue_write",
    )
    # The first three are prefix-extensions of gated names. They are the shapes an
    # unanchored alternation lets through, and a fixture of merely-distinct names
    # cannot see that class at all.
    IGNORED = (
        "mcp__github__add_issue_comment_reaction",
        "mcp__github__issue_write_batch",
        "mcp__claude_ai_Gmail__create_draft_reply",
        "mcp__github__create_pull_request",
        "mcp__github__update_pull_request",
        "mcp__github__pull_request_review_write",
        "mcp__github__add_reply_to_pull_request_comment",
        "mcp__github__merge_pull_request",
        "mcp__claude_ai_Gmail__search_threads",
        "mcp__claude_ai_Google_Drive__read_file_content",
        "mcp__claude_ai_Context7__query-docs",
        "mcp__claude_ai_Google_Calendar__list_events",
        "Read",
    )

    def test_the_matcher_follows_the_gate(self):
        """The fixtures below are readable examples; this is the guarantee.

        A hand-kept list can only test names someone remembered to add, so a new
        or removed MCP_GATED branch slips past it in silence. Equality cannot.
        """
        inner = voice_gate.MCP_GATED.pattern.lstrip("^").rstrip("$")
        self.assertEqual(self.MATCHER, "^(?:" + inner + "|Bash)$")
        # The detector also takes Bash; the routing prompt takes the MCP tools
        # except Gmail. Both are derived, so neither can drift from the gate
        # independently.
        self.assertEqual(len(self.GMAIL_BRANCH.findall(inner)), 1)
        self.assertEqual(self.PROMPT_MATCHER,
                         "^(?:" + self.GMAIL_BRANCH.sub("", inner) + ")$")
        # `.pattern` carries no flags, so equality alone is flag-blind: recompiling
        # the gate leaves the derived string byte-identical while the two stop
        # agreeing on what they match. 32 is re.UNICODE, the default.
        #
        # `re.VERBOSE` is the tempting one — it lets a 500-character one-liner be
        # reformatted for readability. Do not. The harness consumes this pattern as
        # a JSON string with no flags, so whitespace and `#` become literal, the mcp
        # branch stops matching anything, and `Bash` alone keeps matching: the gate
        # goes on firing while every MCP publish quietly stops being gated. A red
        # line here after a reformat is this test working, not this test going stale.
        self.assertEqual(voice_gate.MCP_GATED.flags, re.UNICODE)

    def test_every_judged_tool_reaches_the_hook(self):
        m = re.compile(self.MATCHER)
        for tool in self.JUDGED:
            self.assertTrue(voice_gate.MCP_GATED.match(tool), f"fixture stale: {tool}")
            self.assertTrue(m.match(tool), f"gate judges {tool}; matcher never fires on it")

    def test_the_routing_prompt_skips_artifact_publishes(self):
        # The prompt denied voiced and unvoiced pages alike. Pages are gated
        # outside this plugin, outside this plugin.
        m = re.compile(self.PROMPT_MATCHER)
        for tool in ("Artifact", "mcp__claude-artifacts__publish_files",
                     "mcp__claude-artifacts__publish_version",
                     "mcp__claude-artifacts__edit_version"):
            self.assertFalse(m.match(tool), f"routing prompt fires on {tool}")

    def test_the_routing_prompt_skips_gmail(self):
        # The prompt sees only the call, so it cannot tell a voiced email from an
        # unvoiced one. Gmail is gated outside this plugin; the detector still
        # takes it.
        m, detector = re.compile(self.PROMPT_MATCHER), re.compile(self.MATCHER)
        for verb in ("send_message", "create_draft", "update_draft", "reply", "forward"):
            tool = "mcp__claude_ai_Gmail__" + verb
            self.assertFalse(m.match(tool), f"routing prompt fires on {tool}")
            self.assertTrue(detector.match(tool), f"detector skips {tool}")

    def test_no_tool_spawns_the_hook_for_nothing(self):
        m = re.compile(self.MATCHER)
        for tool in self.IGNORED:
            self.assertFalse(voice_gate.MCP_GATED.match(tool), f"fixture stale: {tool}")
            self.assertFalse(m.match(tool), f"matcher fires on {tool}; the gate ignores it")


class TestOutwardWriteStaysLinear(unittest.TestCase):
    """A gated call can carry a long heredoc body in `cmd`. The detector must
    scan it once, not re-scan the remainder from every starting position."""

    def test_no_match_on_28kb_resolves_in_under_a_second(self):
        body = "word " * 5700  # ~28 KB, no gated domain or write verb anywhere
        cmd = "curl -X POST https://example.com/api --data " + body
        t0 = time.time()
        voice_gate.prose_blobs("Bash", {"command": cmd})
        elapsed = time.time() - t0
        self.assertLess(elapsed, 2.0, f"took {elapsed:.2f}s on a ~28KB command")

    def test_domain_present_no_verb_still_resolves_fast(self):
        body = "word " * 5700
        cmd = "curl https://discord.com/api/webhooks/1 " + body
        t0 = time.time()
        voice_gate.prose_blobs("Bash", {"command": cmd})
        elapsed = time.time() - t0
        self.assertLess(elapsed, 2.0, f"took {elapsed:.2f}s on a ~28KB command")

    def test_many_gh_api_mentions_resolve_fast(self):
        cmd = "gh api " * 8000  # ~56 KB, each mention a candidate anchor
        t0 = time.time()
        voice_gate.prose_blobs("Bash", {"command": cmd})
        elapsed = time.time() - t0
        self.assertLess(elapsed, 1.0, f"took {elapsed:.2f}s on {len(cmd)} bytes")

    def test_still_detects_a_real_gh_api_write(self):
        cmd = 'gh api repos/o/r/issues -X POST -f body="It\'s worth noting that this works."'
        self.assertTrue(voice_gate.gh_api_write(cmd))
        self.assertFalse(voice_gate.gh_api_write("gh api repos/o/r/issues"))

    def test_gh_api_write_with_only_a_subject_field_is_detected(self):
        cmd = 'gh api repos/o/r/issues -X POST -f subject="It is worth noting that this works."'
        self.assertTrue(voice_gate.gh_api_write(cmd))

    def test_pull_request_words_in_a_payload_do_not_exempt_an_issue_write(self):
        for body in ("the PullRequest model", "see https://github.com/o/r/pulls"):
            cmd = f'gh api repos/o/r/issues/5/comments -X POST -f body="{body}"'
            self.assertTrue(voice_gate.gh_api_write(cmd), body)
        self.assertTrue(voice_gate.gh_api_write(
            'gh api repos/o/pulls-tool/issues -X POST -f body="x"'))

    def test_pull_request_endpoint_is_exempt(self):
        self.assertFalse(voice_gate.gh_api_write(
            'gh api repos/o/r/pulls/5/comments -X POST -f body="x"'))
        self.assertFalse(voice_gate.gh_api_write(
            'gh api graphql -f query="mutation { addPullRequestReview(input: {}) { clientMutationId } }" -f body="x"'))

    def test_issue_mutation_naming_pull_request_is_gated(self):
        for q in ("mutation { addComment(input: {subjectId: \"x\"}) { subject { ... on PullRequest { id } } } }",
                  "mutation { createIssue(input: {}) { x } } # PullRequest",
                  "mutation { addPullRequestReview(input: {}) { x } createIssue(input: {}) { x } }"):
            cmd = f"gh api graphql -f query='{q}' -f body=\"x\""
            self.assertTrue(voice_gate.gh_api_write(cmd), q)

    def test_redirection_ampersand_does_not_split_the_command(self):
        for cmd in ('gh api repos/o/r/issues/5/comments 2>&1 -f body="x"',
                    'gh api repos/o/r/issues/5/comments >&2 -f body="x"',
                    'gh api repos/o/r/issues/5/comments &>/dev/null -f body="x"'):
            self.assertTrue(voice_gate.gh_api_write(cmd), cmd)

    def test_pull_path_must_start_the_endpoint(self):
        for ep in ("repos/o/r/issues/5/comments?x=/repos/a/b/pulls/1",
                   "repos/o/r/pulls/1/../../issues/5/comments"):
            self.assertTrue(voice_gate.gh_api_write(f'gh api {ep} -f body="x"'), ep)

    def test_a_decoy_gh_api_mention_does_not_hide_the_write(self):
        cmd = 'gh api repos/o/r/issues/5/comments -f x="gh api repos/o/r/pulls/1" -f body="x"'
        self.assertTrue(voice_gate.gh_api_write(cmd))

    def test_a_write_after_a_nested_call_is_gated(self):
        cmd = 'gh api repos/o/r/issues/5/comments -f t="$(gh api repos/o/r/pulls/1)" -f body="x"'
        self.assertTrue(voice_gate.gh_api_write(cmd))

    def test_a_chained_pull_request_body_is_not_judged(self):
        cmd = ('gh pr create --body "PRMARKER text here" && '
               'gh issue create --title "t" --body "fixes it"')
        blobs = voice_gate.prose_blobs("Bash", {"command": cmd})
        self.assertTrue(blobs)
        self.assertFalse(any("PRMARKER" in b for b in blobs))

    def test_separators_inside_quotes_do_not_split_the_command(self):
        cmd = 'gh api repos/o/r/issues -f label="a;b" -X POST -f body="x | y"'
        self.assertTrue(voice_gate.gh_api_write(cmd))

    def test_heredoc_body_stays_with_its_gh_api_command(self):
        cmd = ("gh api -X POST repos/o/r/issues/1/comments --input - <<'EOF'\n"
               '{"body": "hello"}\nEOF')
        self.assertTrue(voice_gate.gh_api_write(cmd))

    def test_nested_pull_request_call_does_not_exempt_an_issue_write(self):
        cmd = ('gh api repos/o/r/issues -X POST -f body="$(gh api repos/o/r/pulls/1)"')
        self.assertTrue(voice_gate.gh_api_write(cmd))

    def test_still_detects_a_real_outward_write(self):
        cmd = 'curl -X POST https://discord.com/api/webhooks/1 --data \'{"body": "ok"}\''
        self.assertTrue(voice_gate.prose_blobs("Bash", {"command": cmd}))

    def test_outward_write_with_only_a_subject_field_is_detected(self):
        cmd = ('curl -X POST https://discord.com/api/webhooks/1 '
               '--data \'{"subject": "It is worth noting that this works."}\'')
        self.assertTrue(voice_gate.prose_blobs("Bash", {"command": cmd}))


class TestNestedPayloadsAreFound(unittest.TestCase):
    def test_two_levels_deep_is_found(self):
        blobs = voice_gate.prose_blobs(
            "mcp__github__issue_write",
            {"fields": {"component": {"description": "the behaviour changed"}}},
        )
        self.assertEqual(len(blobs), 1)

    def test_prose_inside_a_list_of_dicts_is_found(self):
        # ADF-shaped content: a description carries a list of content nodes.
        blobs = voice_gate.prose_blobs(
            "mcp__github__issue_write",
            {"fields": {"description": {"content": [
                {"type": "paragraph", "text": "it is worth noting this"}
            ]}}},
        )
        self.assertEqual(len(blobs), 1)


class TestBodyFileStdinIsJudged(unittest.TestCase):
    """`--body-file -`/`-F -` names stdin, not a path on disk. The prose that
    feeds it is the echoed/printed text immediately before the pipe, and that
    text is the ENTIRE blob being published -- not a quotation inside it, so
    the generic quoted-span exemption must not blank it."""

    def test_echoed_stdin_body_is_judged(self):
        cmd = 'echo "It is worth noting the behaviour changed." | gh issue create --body-file -'
        blobs = voice_gate.prose_blobs("Bash", {"command": cmd})
        hits = {n for b in blobs for n, _, _ in voice_gate.detect(b, RULES)}
        self.assertTrue(hits, f"no tells found in {blobs!r}")

    def test_stdin_flag_followed_by_shell_punctuation_is_judged(self):
        prose = "It is worth noting the behaviour changed."
        for tail in ("; echo next", ")", " && echo done", "| cat"):
            cmd = f'echo "{prose}" | gh issue create --body-file -{tail}'
            with self.subTest(tail=tail):
                blobs = voice_gate.prose_blobs("Bash", {"command": cmd})
                self.assertIn(prose, blobs)

    def test_printed_stdin_body_is_judged(self):
        cmd = "printf '%s' 'The behaviour is robust.' | gh issue create --body-file -"
        blobs = voice_gate.prose_blobs("Bash", {"command": cmd})
        hits = {n for b in blobs for n, _, _ in voice_gate.detect(b, RULES)}
        self.assertTrue(hits, f"no tells found in {blobs!r}")

    def test_double_quoted_printf_format_plus_value_is_judged(self):
        # printf "%s" "<text>" -- the canonical two-argument form (format
        # string, then value) that avoids the text being reinterpreted as a
        # format string. The format argument must not be mistaken for the value.
        cmd = 'printf "%s" "It is worth noting the behaviour changed." | gh issue create --body-file -'
        blobs = voice_gate.prose_blobs("Bash", {"command": cmd})
        hits = {n for b in blobs for n, _, _ in voice_gate.detect(b, RULES)}
        self.assertTrue(hits, f"no tells found in {blobs!r}")

    def test_nearest_echo_pipe_is_judged_not_an_earlier_one(self):
        # An earlier, unrelated echo/printf-into-pipe must not stand in for the
        # text actually feeding the gated flag.
        cmd = ('echo "irrelevant" | wc -l; '
               'echo "It is worth noting the behaviour changed." | gh issue create -F -')
        blobs = voice_gate.prose_blobs("Bash", {"command": cmd})
        self.assertEqual(blobs, ["It is worth noting the behaviour changed."])

    def test_cat_file_stdin_source_is_read(self):
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
            f.write("It is worth noting the behaviour changed.")
            path = f.name
        try:
            cmd = f"cat {path} | gh issue create -F -"
            blobs = voice_gate.prose_blobs("Bash", {"command": cmd})
            hits = {n for b in blobs for n, _, _ in voice_gate.detect(b, RULES)}
            self.assertTrue(hits, f"no tells found in {blobs!r}")
        finally:
            os.unlink(path)


class TestNoProseTokenInsideProseDoesNotExempt(unittest.TestCase):
    """The exemption applies to the CALL, written by the user outside the
    prose it publishes. A heredoc body is prose, so the literal token landing
    inside one must not blank the gate for the whole call."""

    def test_token_inside_a_heredoc_body_still_gates(self):
        cmd = ("gh issue create --body-file - <<'EOF'\n"
               "Shipping [no-prose] fix for the parser.\n"
               "EOF")
        self.assertTrue(voice_gate.prose_blobs("Bash", {"command": cmd}))

    def test_token_outside_any_payload_still_exempts(self):
        cmd = 'gh issue comment 4 --body "worth noting" [no-prose]'
        self.assertEqual(voice_gate.prose_blobs("Bash", {"command": cmd}), [])


class TestMailSubjectIsJudged(unittest.TestCase):
    def test_subject_field_is_examined(self):
        blobs = voice_gate.prose_blobs(
            "mcp__claude_ai_Gmail__send_message",
            {"to": ["recipient"],
             "subject": "It is worth noting that this fixes the bug",
             "body": "ok"},
        )
        self.assertIn("It is worth noting that this fixes the bug", blobs)


class TestNumericRangeAlreadyHandlesLargeNumbers(unittest.TestCase):
    """Pinning case: a range is still a range when both numbers run longer
    than one digit, and when a sentence carries two of them."""

    def test_two_multi_digit_ranges_in_one_sentence_are_clean(self):
        t = "Between 2024—2025 revenue grew 15—20 percent."
        self.assertEqual(fire(t), set())


class TestPromptHookAnswersInThePromptShape(unittest.TestCase):
    """A `type: prompt` hook is read as {"ok", "reason"}; on PreToolUse,
    ok:false denies. The command-hook shape (hookSpecificOutput) is not read
    from a prompt hook, so a prompt asking for it never denies."""

    def prompt_hooks(self):
        with open(os.path.join(HOOKS, "hooks.json"), encoding="utf-8") as fh:
            spec = json.load(fh)
        return [h for e in spec["hooks"]["PreToolUse"] for h in e["hooks"] if h["type"] == "prompt"]

    def test_there_is_a_prompt_hook(self):
        self.assertTrue(self.prompt_hooks())

    def test_each_prompt_asks_for_ok_and_reason(self):
        for h in self.prompt_hooks():
            with self.subTest(prompt=h["prompt"][:60]):
                self.assertIn('"ok": false', h["prompt"])
                self.assertIn('"reason"', h["prompt"])
                self.assertNotIn("hookSpecificOutput", h["prompt"])
                self.assertNotIn("permissionDecision", h["prompt"])

    def test_each_prompt_reads_the_documented_placeholder(self):
        for h in self.prompt_hooks():
            with self.subTest(prompt=h["prompt"][:60]):
                self.assertIn("$ARGUMENTS", h["prompt"])
                self.assertNotIn("$TOOL_INPUT", h["prompt"])

    def test_a_denial_returns_to_claude(self):
        for h in self.prompt_hooks():
            with self.subTest(prompt=h["prompt"][:60]):
                self.assertIs(h.get("continueOnBlock"), True)


class TestEndToEnd(unittest.TestCase):
    def test_clean_prose_passes(self):
        code, decision = run_hook(
                "mcp__github__add_issue_comment",
                {"commentBody": "Fixed the import and re-ran the suite. All green."},
        )
        self.assertEqual((code, decision), (0, None))

    def test_tells_deny_and_quote_the_span(self):
        code, decision = run_hook(
                "mcp__github__add_issue_comment",
                {"commentBody": "It is worth noting the behaviour changed."},
        )
        self.assertEqual((code, decision), (0, "deny"))

    def test_an_unreadable_profile_refuses_rather_than_passing(self):
        # A gate that cannot read its rules must not wave prose through.
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write("{ not json")
            bad = f.name
        try:
            code, decision = run_hook(
                "mcp__github__add_issue_comment",
                {"commentBody": "It is worth noting the behaviour changed."},
                env={"VOICE_PROFILE": bad},
            )
            self.assertEqual(code, 2)
            self.assertIsNone(decision)
        finally:
            os.unlink(bad)

    def test_malformed_stdin_does_not_block(self):
        p = subprocess.run([sys.executable, GATE], input="not json", capture_output=True, text=True)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main(verbosity=1)
