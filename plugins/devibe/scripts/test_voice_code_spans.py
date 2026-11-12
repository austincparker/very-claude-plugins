#!/usr/bin/env python3
"""Cases for code_spans.py: masked code survives a rewrite byte for byte."""
import html
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "skills" / "voice" / "scripts" / "code_spans.py"


class Quiet(unittest.TextTestResult):
    def addSuccess(self, test):
        pass

    def printErrors(self):
        pass


def run(*args):
    p = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def put(self, name, text):
        path = self.dir / name
        path.write_bytes(text.encode("utf-8"))
        return path

    def mask(self, text):
        draft = self.put("draft.md", text)
        rc, out, err = run("mask", str(draft), "--execute")
        self.assertEqual(rc, 0, err)
        info = json.loads(out)
        return (pathlib.Path(info["masked"]).read_bytes().decode("utf-8"),
                pathlib.Path(info["spans"]), info["count"])

    def restore(self, rewrite_text, spans, *extra):
        rewrite = self.put("rewrite.md", rewrite_text)
        rc, out, err = run("restore", str(rewrite), "--spans", str(spans), "--execute", *extra)
        if rc != 0:
            return rc, None, err
        info = json.loads(out)
        return rc, pathlib.Path(info["restored"]).read_bytes().decode("utf-8"), err

    def round_trip(self, text):
        masked, spans, _ = self.mask(text)
        rc, restored, err = self.restore(masked, spans)
        self.assertEqual(rc, 0, err)
        self.assertEqual(restored, text)
        return masked


class RoundTrip(Base):
    def test_fence_with_info_string(self):
        text = "Intro\n\n```bash\nmake && make test\n```\n\nOutro\n"
        masked = self.round_trip(text)
        self.assertNotIn("make", masked)

    def test_tilde_fence(self):
        masked = self.round_trip("a\n~~~\nx <= y\n~~~\nb\n")
        self.assertNotIn("<=", masked)

    def test_nested_backticks_inline(self):
        masked = self.round_trip("use ``a ` b`` and `c` here\n")
        self.assertNotIn("`", masked)

    def test_fence_containing_backticks(self):
        text = "````md\n```py\nprint(1)\n```\n````\nafter `x`\n"
        masked = self.round_trip(text)
        self.assertNotIn("print", masked)
        self.assertNotIn("after `", masked)

    def test_shorter_fence_does_not_close(self):
        masked = self.round_trip("```\na\n``\nb\n```\ntail\n")
        self.assertEqual(masked.count("\n"), 2)
        self.assertTrue(masked.endswith("tail\n"))

    def test_crlf(self):
        text = "line `a && b`\r\n\r\n```\r\ncode <key>\r\n```\r\nend\r\n"
        masked = self.round_trip(text)
        self.assertNotIn("<key>", masked)
        self.assertIn("\r\n", masked)

    def test_unclosed_fence_runs_to_end(self):
        text = "before\n```\nrest `x`\nmore &&"
        masked = self.round_trip(text)
        self.assertEqual(masked.split("\n")[0], "before")
        self.assertNotIn("more", masked)

    def test_unmatched_backtick_stays_prose(self):
        text = "a stray ``` tick and `real` span\n"
        masked = self.round_trip(text)
        self.assertIn("a stray ``` tick", masked)

    def test_span_does_not_cross_blank_line(self):
        text = "open ` here\n\nthen `x`\n"
        masked = self.round_trip(text)
        self.assertIn("open ` here", masked)

    def test_no_code_unchanged(self):
        text = "Plain prose, no code.\nSecond line.\n"
        masked, _, count = self.mask(text)
        self.assertEqual(masked, text)
        self.assertEqual(count, 0)
        self.round_trip(text)

    def test_placeholders_are_ascii_alnum_and_unique(self):
        masked, spans, count = self.mask("`a` `b` `c`\n```\nd\n```\n")
        self.assertEqual(count, 4)
        ids = [s["id"] for s in json.loads(spans.read_text())["spans"]]
        self.assertEqual(len(set(ids)), 4)
        for i in ids:
            self.assertRegex(i, r"^[A-Za-z0-9]+$")
            self.assertEqual(masked.count(i), 1)

    def test_draft_containing_placeholder_prefix(self):
        self.round_trip("VOICECODE0001 `x`\n")


class SimulatedRewrite(Base):
    def rewrite(self, masked):
        out = []
        for part in re.split(r"([A-Za-z]*VOICECODE[A-Za-z0-9]*)", masked):
            if "VOICECODE" in part:
                out.append(part)
            else:
                out.append(html.escape(part.replace("utilize", "use")))
        return "".join(out)

    def test_measured_cases_survive(self):
        text = ("We utilize `make && make test` and `<key>` here.\n\n"
                "```\nif a <= b && c > d: <udid>\n```\n\nThat's it & done.\n")
        masked, spans, _ = self.mask(text)
        rc, restored, err = self.restore(self.rewrite(masked), spans)
        self.assertEqual(rc, 0, err)
        for original in ("`make && make test`", "`<key>`", "if a <= b && c > d: <udid>"):
            self.assertIn(original, restored)
        self.assertNotIn("&amp;", restored.split("That")[0])
        self.assertIn("We use ", restored)


class Refusals(Base):
    def setUp(self):
        super().setUp()
        self.masked, self.spans, _ = self.mask("one `a` two `b` three\n")
        self.ids = [s["id"] for s in json.loads(self.spans.read_text())["spans"]]

    def refuses(self, text, needle):
        rc, restored, err = self.restore(text, self.spans)
        self.assertEqual(rc, 1, err)
        self.assertIn(needle, err)
        self.assertEqual(len(err.strip().splitlines()), 1)

    def test_dropped(self):
        self.refuses(self.masked.replace(self.ids[0], ""), self.ids[0])

    def test_duplicated(self):
        self.refuses(self.masked + " " + self.ids[1], self.ids[1])

    def test_edited(self):
        self.refuses(self.masked.replace(self.ids[1], self.ids[1].lower()), self.ids[1])

    def test_invented(self):
        fake = self.ids[0][:-5] + "9999Z"
        self.refuses(self.masked + " " + fake, fake)

    def test_dry_run_still_checks(self):
        rewrite = self.put("r.md", self.masked.replace(self.ids[0], ""))
        rc, _, _ = run("restore", str(rewrite), "--spans", str(self.spans))
        self.assertEqual(rc, 1)


class Cli(Base):
    def test_dry_run_writes_nothing(self):
        draft = self.put("draft.md", "`a`\n")
        rc, out, _ = run("mask", str(draft))
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["count"], 1)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["draft.md"])

    def test_missing_file_exits_2(self):
        rc, _, err = run("mask", str(self.dir / "nope.md"), "--execute")
        self.assertEqual(rc, 2)
        self.assertTrue(err.strip())

    def round_trip(self, text):
        draft = self.put("d.md", text)
        self.assertEqual(run("mask", str(draft), "--execute")[0], 0)
        masked = draft.parent / "d.md.masked.md"
        rc, _, err = run("restore", str(masked), "--spans", str(draft.parent / "d.md.spans.json"), "--execute")
        self.assertEqual(rc, 0, err)
        return masked.read_text(), (draft.parent / "d.md.masked.md.restored.md").read_text()

    def test_text_attached_to_a_span_restores(self):
        text = "a `foo`s and `v`2 end\n"
        masked, restored = self.round_trip(text)
        self.assertNotIn("`", masked)
        self.assertEqual(restored, text)

    def test_escaped_backslash_before_backtick_opens_a_span(self):
        text = "x \\\\`a && b` y\n"
        masked, restored = self.round_trip(text)
        self.assertNotIn("&&", masked)
        self.assertEqual(restored, text)

    def test_escaped_backtick_is_not_a_span(self):
        text = "esc \\`not` end\n"
        masked, restored = self.round_trip(text)
        self.assertEqual(masked, text)

    def test_unicode_line_separator_does_not_open_a_fence(self):
        text = "a\x0c```\nb\n"
        masked, restored = self.round_trip(text)
        self.assertEqual(restored, text)
        self.assertIn("b", masked)

    def test_indented_code_is_not_a_fence(self):
        text = "    ```\n    keep `a` here\nprose\n"
        masked, restored = self.round_trip(text)
        self.assertIn("prose", masked)
        self.assertEqual(restored, text)

    def test_over_9999_spans_restore(self):
        text = "".join(f"`s{i}` " for i in range(10005)) + "\n"
        masked, restored = self.round_trip(text)
        self.assertEqual(restored, text)

    def test_fence_inside_a_list_item_is_masked(self):
        text = "- step\n\n    ```\n    a &amp; b\n    ```\n\n- next\n"
        masked = self.round_trip(text)
        self.assertNotIn("&amp;", masked)

    def test_out_cannot_overwrite_the_draft(self):
        draft = self.put("draft.md", "text `x`\n")
        rc, _, err = run("mask", str(draft), "--out", str(draft), "--execute")
        self.assertEqual(rc, 2, err)
        self.assertEqual(draft.read_text(), "text `x`\n")

    def test_spans_and_out_must_differ(self):
        draft = self.put("draft.md", "text\n")
        same = self.dir / "same.json"
        rc, _, _ = run("mask", str(draft), "--out", str(same), "--spans", str(same), "--execute")
        self.assertEqual(rc, 2)

    def test_overrides_are_honored(self):
        draft = self.put("draft.md", "a `x` b\n")
        out, spans = self.dir / "m.txt", self.dir / "s.json"
        rc, _, err = run("mask", str(draft), "--out", str(out), "--spans", str(spans), "--execute")
        self.assertEqual(rc, 0, err)
        rewrite = self.put("rw.md", out.read_text())
        restored = self.dir / "r.txt"
        rc, _, err = run("restore", str(rewrite), "--spans", str(spans), "--out", str(restored), "--execute")
        self.assertEqual(rc, 0, err)
        self.assertEqual(restored.read_text(), "a `x` b\n")

    def test_malformed_spans_exit_two(self):
        rewrite = self.put("rw.md", "text\n")
        for body in ('{"salt": "ab", "spans": [{"id": "x"}]}', '{"salt": 1, "spans": []}',
                     '{"salt": "ab", "spans": [3]}', "not json"):
            spans = self.put("s.json", body)
            rc, _, _ = run("restore", str(rewrite), "--spans", str(spans), "--execute")
            self.assertEqual(rc, 2, body)

    def test_a_failed_restore_leaves_no_stale_output(self):
        masked, spans, _ = self.mask("a `x` b\n")
        rc, restored, _ = self.restore(masked, spans)
        self.assertEqual(rc, 0)
        rc, _, _ = self.restore("placeholder dropped\n", spans)
        self.assertEqual(rc, 1)
        self.assertFalse((self.dir / "rewrite.md.restored.md").exists())

    def test_a_lowercase_copy_of_a_placeholder_is_refused(self):
        masked, spans, _ = self.mask("a `x` b\n")
        rc, _, err = self.restore(masked + masked.lower(), spans)
        self.assertEqual(rc, 1, err)

    def test_a_write_failure_exits_two(self):
        draft = self.put("draft.md", "a\n")
        rc, _, _ = run("mask", str(draft), "--out", str(self.dir / "missing" / "m.md"), "--execute")
        self.assertEqual(rc, 2)

    def test_the_salt_widens_when_the_prefix_is_taken(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("code_spans", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        class FixedDigest:
            def hexdigest(self):
                return "abcdef0123456789"

        mod.hashlib = type("H", (), {"sha1": staticmethod(lambda b: FixedDigest())})
        self.assertEqual(mod.pick_salt("plain"), "abcd")
        self.assertEqual(mod.pick_salt("has " + mod.PREFIX + "abcd inside"), "abcde")

    def test_help_documents_exit_codes(self):
        rc, out, _ = run("--help")
        self.assertEqual(rc, 0)
        for code in ("0", "1", "2"):
            self.assertIn(code, out)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(stream=open("/dev/null", "w"), resultclass=Quiet).run(suite)
    for test, _ in result.failures + result.errors:
        print(test.id().split(".", 1)[-1])
    if result.wasSuccessful():
        print("OK")
    sys.exit(0 if result.wasSuccessful() else 1)
