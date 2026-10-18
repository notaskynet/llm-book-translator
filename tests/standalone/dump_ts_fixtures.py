"""Dump reference data from the Python implementation for the TypeScript app.

The static app under app/ ports the prompts and the chunker 1:1. This script
captures what the Python code produces so the TS tests can assert the ports
match, and exports the language example tables so they are not retyped by hand.

Usage (from the repo root, with python-dotenv and tiktoken installed):

    python tests/standalone/dump_ts_fixtures.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src.core.chunking.token_chunker import TokenChunker  # noqa: E402
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


def main() -> None:
    dump_language_tables()
    FIXTURES_OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {"prompts": prompt_cases(), "chunker": chunker_cases(), "split": split_cases()}
    FIXTURES_OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {DATA_OUT.relative_to(ROOT)} and {FIXTURES_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
