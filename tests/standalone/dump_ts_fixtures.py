"""Dump reference data from the Python implementation for the TypeScript app.

The static app under app/ ports the prompts and the chunker 1:1. This script
captures what the Python code produces so the TS tests can assert the ports
match, and exports the language example tables so they are not retyped by hand.

Usage (from the repo root, with python-dotenv and tiktoken installed):

    python tests/standalone/dump_ts_fixtures.py
"""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import src.config as cfg  # noqa: E402
from src.core.adapters.srt_adapter import SrtAdapter  # noqa: E402
from src.core.adapters.txt_adapter import TxtAdapter  # noqa: E402
from src.core.chunking.token_chunker import TokenChunker  # noqa: E402
from src.core.epub.body_serializer import normalize_whitespace  # noqa: E402
from src.core.epub.html_chunker import HtmlChunker  # noqa: E402
from src.core.epub.html_utils import (  # noqa: E402
    extract_text_and_positions,
    is_text_free_chunk,
    reinsert_placeholders,
)
from src.core.epub.lang_support import (  # noqa: E402
    LANGUAGE_NAME_TO_CODE,
    _REGIONAL_NAME_TO_CODE,
    get_language_code,
)
from src.core.epub.tag_preservation import TagPreserver, is_non_translatable  # noqa: E402
from src.core.epub.token_alignment_fallback import TokenAlignmentFallback  # noqa: E402
from src.core.epub.xhtml_translator import (  # noqa: E402
    PlaceholderManager,
    _escape_stray_angle_brackets,
    validate_placeholders,
)
from src.core.srt_processor import SRTProcessor  # noqa: E402
from src.core.translator import split_chunk_for_retry  # noqa: E402
from src.prompts.examples.placeholder_examples import TRANSLATIONS  # noqa: E402
from src.prompts.prompts import (  # noqa: E402
    generate_placeholder_correction_prompt,
    generate_subtitle_block_prompt,
    generate_translation_prompt,
)

APP = ROOT / "app"
DATA_OUT = APP / "src" / "prompts" / "data" / "language-examples.json"
FIXTURES_OUT = APP / "test" / "fixtures" / "python-reference.json"


def dump_language_tables() -> None:
    DATA_OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = TRANSLATIONS
    DATA_OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def prompt_cases() -> list:
    cases = []

    def add(name, pair, **inputs):
        cases.append({"name": name, "inputs": inputs, "system": pair.system, "user": pair.user})

    base = dict(
        main_content="It was a quiet night.",
        context_before="Before text.",
        context_after="After text.",
        previous_translation_context="Texte précédent.",
    )
    for target in ("French", "Chinese", "Portuguese (Brazil)", "Klingon"):
        for placeholders in (False, True):
            add(
                f"translation/{target}/placeholders={placeholders}",
                generate_translation_prompt(
                    **base, source_language="English", target_language=target,
                    has_placeholders=placeholders,
                ),
                kind="translation", **base, source_language="English",
                target_language=target, has_placeholders=placeholders,
            )

    options = {"text_cleanup": True, "custom_instructions": "Use a formal register."}
    for placeholders in (False, True):
        add(
            f"translation/options/placeholders={placeholders}",
            generate_translation_prompt(
                **base, source_language="Russian", target_language="German",
                has_placeholders=placeholders, prompt_options=options,
                glossary_block="# GLOSSARY\n- night = Nacht",
            ),
            kind="translation", **base, source_language="Russian", target_language="German",
            has_placeholders=placeholders, prompt_options=options,
            glossary_block="# GLOSSARY\n- night = Nacht",
        )

    retry_options = {"plain_text_expected_paragraphs": 3}
    add(
        "translation/plain-text-retry",
        generate_translation_prompt(
            **base, source_language="English", target_language="French",
            has_placeholders=False, prompt_options=retry_options,
        ),
        kind="translation", **base, source_language="English", target_language="French",
        has_placeholders=False, prompt_options=retry_options,
    )

    blocks = [(1, "Hello there."), (2, "<i>How are you?</i>")]
    for target in ("Spanish", "Japanese"):
        add(
            f"subtitle/{target}",
            generate_subtitle_block_prompt(
                blocks, "[1]Hola.", "English", target, custom_instructions="Keep it casual.",
            ),
            kind="subtitle", subtitle_blocks=blocks, previous_translation_block="[1]Hola.",
            source_language="English", target_language=target,
            custom_instructions="Keep it casual.", glossary_block="",
        )

    for count in (2, 5):
        add(
            f"correction/count={count}",
            generate_placeholder_correction_prompt(
                "[id0]Hello[id1] world", "Bonjour monde", "Missing: [id0], [id1]",
                "English", "French", count,
            ),
            kind="correction", original_text="[id0]Hello[id1] world",
            translated_text="Bonjour monde", specific_errors="Missing: [id0], [id1]",
            source_language="English", target_language="French", expected_count=count,
        )
    return cases


def chunker_cases() -> list:
    sentence = "The traveller walked slowly along the old road. "
    cjk_sentence = "他慢慢地走在古老的路上。"
    texts = {
        "paragraphs": "\n\n".join(f"Paragraph {i}. " + sentence * 6 for i in range(12)),
        "oversized-paragraph": sentence * 120,
        "one-paragraph-per-line": "\n".join(f"Line {i}. " + sentence * 3 for i in range(40)),
        "cjk-oversized": cjk_sentence * 400,
        "short": "Just one short paragraph.",
        "blank": "  \n\n  ",
    }
    cases = []
    for name, text in texts.items():
        for max_tokens in (100, 450):
            chunker = TokenChunker(max_tokens=max_tokens)
            cases.append({
                "name": f"{name}/max={max_tokens}",
                "text": text,
                "max_tokens": max_tokens,
                "token_count": chunker.count_tokens(text),
                "chunks": chunker.chunk_text(text),
            })
    return cases


def split_cases() -> list:
    single = "First sentence here. Second sentence follows. Third one ends it. " * 6
    multi = "\n".join(f"Line number {i} ends here." for i in range(20))
    cases = []
    for name, text in (("single-line", single), ("multi-line", multi)):
        for ratio in (0.5, 0.6, 0.36):
            first, second = split_chunk_for_retry(text, ratio)
            cases.append({"name": f"{name}/{ratio}", "text": text, "ratio": ratio,
                          "first": first, "second": second})
    return cases


SAMPLE_SRT = """1
00:00:01,000 --> 00:00:03,000
Hello there.

2
00:00:03,500 --> 00:00:05,000
<i>How are you?</i>
I am fine.

3
00:00:05,500 --> 00:00:06,000


4
00:00:07,000 --> 00:00:09,000
- Good.
- Great.

5
00:00:10,000 --> 00:00:12,000
See you tomorrow.
"""


def _fake_translation(text: str) -> str:
    """Deterministic stand-in for the LLM: keeps the [N] markers, tags the text."""
    return "\n".join(
        line if not line.strip() else (line[: line.index("]") + 1] + "TR " + line[line.index("]") + 1:]
                                       if line.startswith("[") else "TR " + line)
        for line in text.split("\n")
    )


async def _run_txt(text: str, max_tokens: int, translate_every: int):
    with tempfile.TemporaryDirectory() as tmp:
        src_path, out_path = Path(tmp) / "in.txt", Path(tmp) / "out.txt"
        src_path.write_text(text, encoding="utf-8")
        adapter = TxtAdapter(str(src_path), str(out_path), {"max_tokens_per_chunk": max_tokens})
        await adapter.prepare_for_translation()
        units = adapter.get_translation_units()
        translated = {}
        for i, unit in enumerate(units):
            if i % translate_every == 0:
                translated[unit.unit_id] = "TR " + unit.content
                await adapter.save_unit_translation(unit.unit_id, translated[unit.unit_id])
        return {
            "units": [
                {"unit_id": u.unit_id, "content": u.content, "context_before": u.context_before,
                 "context_after": u.context_after, "metadata": u.metadata}
                for u in units
            ],
            "translated": translated,
            "validation": {
                u.unit_id: adapter.validate_unit_translation(u.unit_id, "x") for u in units
            },
            "output": (await adapter.reconstruct_output()).decode("utf-8"),
            "bilingual": (await adapter.reconstruct_output(bilingual=True)).decode("utf-8"),
        }


async def _run_srt(content: str, lines_per_block: int, skip_blocks: set):
    cfg.ATTRIBUTION_ENABLED = False  # the app does not append the upstream signature
    with tempfile.TemporaryDirectory() as tmp:
        src_path, out_path = Path(tmp) / "in.srt", Path(tmp) / "out.srt"
        src_path.write_text(content, encoding="utf-8")
        adapter = SrtAdapter(str(src_path), str(out_path), {"lines_per_block": lines_per_block})
        ok = await adapter.prepare_for_translation()
        units = adapter.get_translation_units()
        validations = {}
        for i, unit in enumerate(units):
            if i in skip_blocks:
                continue
            fake = _fake_translation(unit.content)
            validations[unit.unit_id] = adapter.validate_unit_translation(unit.unit_id, fake)
            await adapter.save_unit_translation(unit.unit_id, fake)
        return {
            "prepared": ok,
            "subtitles": adapter.subtitles and [dict(s) for s in adapter.subtitles],
            "units": [
                {"unit_id": u.unit_id, "content": u.content, "context_before": u.context_before,
                 "context_after": u.context_after, "metadata": u.metadata}
                for u in units
            ],
            "validations": validations,
            "missing_marker_feedback": adapter.validate_unit_translation(units[0].unit_id, "[0]only first"),
            "output": (await adapter.reconstruct_output()).decode("utf-8"),
            "bilingual": (await adapter.reconstruct_output(bilingual=True)).decode("utf-8"),
        }


def adapter_cases() -> dict:
    sentence = "The traveller walked slowly along the old road. "
    txt_text = "\n\n".join(f"Paragraph {i}. " + sentence * 8 for i in range(9)) + "\n\n" + sentence * 60
    txt_cases = []
    for name, text, max_tokens, every in (
        ("paragraphs", txt_text, 120, 1),
        ("partial", txt_text, 120, 2),
        ("short", "One short paragraph.", 450, 1),
    ):
        txt_cases.append({"name": name, "text": text, "max_tokens": max_tokens,
                          **asyncio.run(_run_txt(text, max_tokens, every))})

    srt_cases = []
    for name, content, lpb, skip in (
        ("sample/3", SAMPLE_SRT, 3, set()),
        ("sample/10", SAMPLE_SRT, 10, set()),
        ("sample/2-skip-second", SAMPLE_SRT, 2, {1}),
        ("crlf", SAMPLE_SRT.replace("\n", "\r\n"), 2, set()),
        ("empty", "not an srt file", 3, set()),
    ):
        try:
            srt_cases.append({"name": name, "content": content, "lines_per_block": lpb,
                              "skip_blocks": sorted(skip), **asyncio.run(_run_srt(content, lpb, skip))})
        except IndexError:
            # `empty`: no subtitles, so there are no units to validate.
            srt_cases.append({"name": name, "content": content, "lines_per_block": lpb,
                              "skip_blocks": [], "prepared": False})

    processor = SRTProcessor()
    remap = []
    for text, mapping in (
        ("[0]Hello\n[1]World", {0: 458, 1: 459}),
        ("[0]Hello [1]World", {0: 5, 1: 6}),
        ("[0]Line one\nline two\n[1]Other", {0: 0, 1: 1}),
        ("[0]\n[1]Only second", {0: 0, 1: 1}),
        ("[2]Unknown index\n[0]Known", {0: 9}),
    ):
        got = processor.extract_block_translations_with_remapping(text, mapping)
        remap.append({"text": text, "mapping": {str(k): v for k, v in mapping.items()},
                      "result": {str(k): v for k, v in got.items()}})
    return {"txt": txt_cases, "srt": srt_cases, "srt_remap": remap}


EPUB_DATA_OUT = APP / "src" / "epub" / "data" / "language-codes.json"


def epub_cases() -> dict:
    sentence = "The traveller walked slowly along the old road. "
    long_para = "<p>" + sentence * 30 + "</p>"
    bodies = {
        "simple": "<p>Hello <b>brave</b> world.</p>\n<p>Second paragraph.</p>",
        "nested": '<div class="chapter"><h1 id="c1">Chapter One</h1>\n<p class="x">It was <i>a dark</i> and '
                  '<span style="color:red">stormy</span> night.</p>\n<p>The rain fell.<br/>Again.</p></div>',
        "numbers-and-empties": "<p> </p>\n<p>1.</p>\n<h2>III</h2>\n<p>Real text here.</p>\n<p>42</p>",
        "image": '<p><img src="a.png" alt="x"/></p>\n<p>Caption text.</p>',
        "entities": "<p>Fish &amp; chips &lt;3 &#233;t&#233;.</p>",
        "oversized": "<div>" + long_para + "\n" + long_para + "\n<p>Short tail.</p></div>",
        "list-and-table": "<ul><li>One apple</li><li>Two pears</li></ul>\n"
                          "<table><tr><td>Cell A</td><td>Cell B</td></tr></table>",
        "cjk": "<p>他慢慢地走在古老的路上。天色已晚，雨下得很大。</p>\n<p>第二段。</p>",
    }
    cases = []
    for name, body in bodies.items():
        preserver = TagPreserver()
        text, tag_map = preserver.preserve_tags(body)
        restored = preserver.restore_tags(text, tag_map)
        case = {"name": name, "body": body, "text": text, "tag_map": tag_map, "restored": restored, "chunks": {}}
        for max_tokens in (60, 450):
            chunks = HtmlChunker(max_tokens=max_tokens).chunk_html_with_placeholders(text, tag_map)
            case["chunks"][str(max_tokens)] = chunks
        cases.append(case)

    non_translatable = [
        "", "   ", "1", "1.", "1.2", "III", "IV.", "(1)", "1-", "Hello", "12 apples", "—", "\u00a0", "MIX", "civil",
    ]
    ws_inputs = [
        "<p>Line one\n   continues here.</p><p>Next</p>",
        "<p>A</p>\n\n\n<p>B</p>",
        "<pre>keep\n   this</pre><p>wrap\n   me</p>",
        "<p>One<br/>Two<br>Three</p>",
        "<div>text   with    spaces</div>",
    ]
    escape_inputs = [
        "plain text", "Fish & chips", "AT&T", "&amp; already", "caf&eacute; &nbsp; au lait", "a < b > c",
        "&#233; &#xE9; &#99999999;", "&unknown; &", "<Skill> activated", "[id0]Text &hellip;[id1]",
    ]
    text_free = ["[id0]", "[id0]==[id1]", "[id0]……[id1]", "[id0]第1章[id1]", "[id0]2024[id1]", "[id0]Hello[id1]", ""]

    placeholders_cases = []
    for chunk_text, tag_map in (
        ("[id0]Bonjour[id1] monde[id2]", {"[id0]": "<p>", "[id1]": "<b>", "[id2]": "</b></p>"}),
        ("[id0]Bonjour monde[id2]", {"[id0]": "<p>", "[id1]": "<b>", "[id2]": "</p>"}),
        ("[id1]Bonjour[id0] monde[id2]", {"[id0]": "<p>", "[id1]": "<b>", "[id2]": "</p>"}),
        ("[id0]Bonjour[id0] monde[id1]", {"[id0]": "<p>", "[id1]": "</p>"}),
        ("Bonjour", {}),
        ("[id0]a[id1]b[id2]c[id3]", {"[id0]": "", "[id1]": "", "[id2]": ""}),
    ):
        placeholders_cases.append({"text": chunk_text, "tag_map": tag_map, "valid": validate_placeholders(chunk_text, tag_map)})

    restore_cases = [
        {"text": "[id0]Bonjour[id1] monde[id2]", "global_indices": [5, 6, 7],
         "result": PlaceholderManager.restore_to_global("[id0]Bonjour[id1] monde[id2]", [5, 6, 7])},
        {"text": "[id0]a[id1]b[id10]", "global_indices": [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
         "result": PlaceholderManager.restore_to_global("[id0]a[id1]b[id10]", [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])},
        {"text": "no placeholders", "global_indices": [], "result": "no placeholders"},
    ]

    aligner = TokenAlignmentFallback()
    align_cases = []
    for original, translated in (
        ("[id0]Hello[id1] world[id2]", "Bonjour monde"),
        ("[id0]The [id1]quick[id2] brown fox[id3]", "Le renard brun rapide"),
        ("[id0]Only text[id1]", "Seulement du texte"),
        ("[id0][id1]Text[id2]", "Texte"),
        ("[id0]他慢慢地走[id1]在路上[id2]", "He walked slowly on the road"),
        ("[id0]x[id1]", ""),
    ):
        phs = [f"[id{m.group(1)}]" for m in __import__("re").finditer(r"\[id(\d+)\]", original)]
        align_cases.append({
            "original": original, "translated": translated, "placeholders": phs,
            "result": aligner.align_and_insert_placeholders(original, translated, phs),
        })

    reinsert_cases = []
    for original, translated in (
        ("[id0]Hello [id1]world[id2]", "Bonjour monde"),
        ("[id0]a[id1]b[id2]c[id3]", "alpha beta gamma"),
    ):
        _, positions = extract_text_and_positions(original)
        reinsert_cases.append({
            "original": original, "translated": translated,
            "positions": {str(k): v for k, v in positions.items()},
            "result": reinsert_placeholders(translated, positions),
        })

    lang_inputs = [
        "English", "french", "  German ", "Portuguese (Brazil)", "Portuguese (Portugal)", "Portuguese", "en-US",
        "fr", "zh-CN", "Arabic", "Hebrew", "Persian", "Klingon", "", "Chinese", "Filipino", "Norwegian",
    ]
    return {
        "epub_bodies": cases,
        "epub_non_translatable": [{"text": t, "result": is_non_translatable(t)} for t in non_translatable],
        "epub_whitespace": [{"html": h, "result": normalize_whitespace(h)} for h in ws_inputs],
        "epub_escape": [{"text": t, "result": _escape_stray_angle_brackets(t)} for t in escape_inputs],
        "epub_text_free": [{"text": t, "result": is_text_free_chunk(t)} for t in text_free],
        "epub_validate": placeholders_cases,
        "epub_restore": restore_cases,
        "epub_align": align_cases,
        "epub_reinsert": reinsert_cases,
        "epub_lang": [{"input": i, "result": get_language_code(i)} for i in lang_inputs],
        "_language_codes": {"names": LANGUAGE_NAME_TO_CODE, "regional": _REGIONAL_NAME_TO_CODE},
    }


def main() -> None:
    dump_language_tables()
    FIXTURES_OUT.parent.mkdir(parents=True, exist_ok=True)
    epub = epub_cases()
    EPUB_DATA_OUT.parent.mkdir(parents=True, exist_ok=True)
    EPUB_DATA_OUT.write_text(json.dumps(epub.pop("_language_codes"), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    payload = {
        "prompts": prompt_cases(),
        "chunker": chunker_cases(),
        "split": split_cases(),
        **adapter_cases(),
        **epub,
    }
    FIXTURES_OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {DATA_OUT.relative_to(ROOT)} and {FIXTURES_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
